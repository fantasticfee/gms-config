/**
 * APKMirror 直链爬虫
 *
 * 工作流程：
 * 1. 读取 config/packages.json 中定义的目标包
 * 2. 对每个包，访问 APKMirror 获取最新版本
 * 3. 进入版本页面，获取所有变体（按架构/Android版本/DPI）
 * 4. 对每个需要的变体，模拟点击获取直接下载链接
 * 5. 输出 variants.json
 *
 * 使用 Playwright 而非 Puppeteer，因为：
 * - 内置更好的 Cloudflare 绕过能力
 * - 自动等待机制更可靠
 * - 浏览器管理更简单
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ============================================================
//  配置
// ============================================================

const BASE_URL = "https://www.apkmirror.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// 请求间隔（毫秒），避免被封
const DELAY_BETWEEN_PAGES = 3000;
const DELAY_BETWEEN_VARIANTS = 5000;

// 需要爬取的架构和 Android 版本组合
const TARGET_COMBINATIONS = [
  { arch: "arm64-v8a", minAndroid: "14.0", label: "arm64-v8a / Android 14+" },
  { arch: "arm64-v8a", minAndroid: "13.0", label: "arm64-v8a / Android 13" },
  { arch: "arm64-v8a", minAndroid: "12.0", label: "arm64-v8a / Android 12" },
  { arch: "arm64-v8a", minAndroid: "11.0", label: "arm64-v8a / Android 11" },
  { arch: "armeabi-v7a", minAndroid: "11.0", label: "armv7 / Android 11+" },
];

// ============================================================
//  工具函数
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${msg}`);
}

function logError(msg) {
  const time = new Date().toISOString().slice(11, 19);
  console.error(`[${time}] ❌ ${msg}`);
}

/**
 * 将 APKMirror 页面上的 Android 版本文本解析为数字
 * 例如 "Android 14.0+" → 14.0
 */
function parseAndroidVersion(text) {
  const match = text.match(/(\d+\.\d+)/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * 从变体描述中提取架构信息
 */
function extractArch(text) {
  const archMap = {
    "arm64-v8a": "arm64-v8a",
    armeabi: "armeabi-v7a",
    "armeabi-v7a": "armeabi-v7a",
    x86_64: "x86_64",
    x86: "x86",
    universal: "universal",
  };
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(archMap)) {
    if (lower.includes(key.toLowerCase())) return value;
  }
  return "unknown";
}

/**
 * 从变体描述中提取 DPI
 */
function extractDpi(text) {
  const match = text.match(/(\d+)dpi/i);
  if (match) return match[1] + "dpi";
  if (text.toLowerCase().includes("nodpi")) return "nodpi";
  return "nodpi";
}

// ============================================================
//  核心爬虫类
// ============================================================

class ApkMirrorCrawler {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /** 启动浏览器 */
  async init() {
    log("启动浏览器...");
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    this.context = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      // 模拟真实浏览器特征
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    });

    this.page = await this.context.newPage();

    // 移除 webdriver 标记，降低被检测风险
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    log("浏览器已启动");
  }

  /** 关闭浏览器 */
  async close() {
    if (this.browser) {
      await this.browser.close();
      log("浏览器已关闭");
    }
  }

  /**
   * 访问页面并等待加载，带重试
   */
  async navigateWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log(`  访问: ${url} (尝试 ${attempt}/${maxRetries})`);
        await this.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        // 检查是否被 Cloudflare 拦截
        const title = await this.page.title();
        if (
          title.includes("Just a moment") ||
          title.includes("Attention Required")
        ) {
          log("  ⚠️ Cloudflare challenge，等待 10 秒...");
          await sleep(10000);

          // 等待 challenge 完成
          await this.page.waitForFunction(
            () =>
              !document.title.includes("Just a moment") &&
              !document.title.includes("Attention Required"),
            { timeout: 30000 }
          );
        }

        return true;
      } catch (e) {
        logError(`  访问失败: ${e.message}`);
        if (attempt < maxRetries) {
          await sleep(5000 * attempt);
        }
      }
    }
    return false;
  }

  /**
   * 步骤 1: 获取某个包的最新稳定版本 URL
   *
   * @param {string} packagePath - APKMirror 上的包路径
   *   例如: "google-inc/google-play-services"
   * @returns {object|null} { version, versionUrl }
   */
  async getLatestVersion(packagePath) {
    const url = `${BASE_URL}/apk/${packagePath}/`;
    const ok = await this.navigateWithRetry(url);
    if (!ok) return null;

    try {
      // APKMirror 版本列表页的结构:
      // div.listWidget > div.appRow > 各版本条目
      // 每个条目中 h5.appRowTitle > a 包含版本名和链接
      const versions = await this.page.$$eval(
        ".listWidget .appRow",
        (rows) => {
          const results = [];
          for (const row of rows) {
            const link = row.querySelector("h5.appRowTitle a, .appRowTitle a");
            if (!link) continue;

            const versionText = link.textContent.trim();
            const href = link.getAttribute("href");

            // 跳过 beta/alpha 版本
            const lower = versionText.toLowerCase();
            if (
              lower.includes("beta") ||
              lower.includes("alpha") ||
              lower.includes("wear")
            ) {
              continue;
            }

            results.push({
              version: versionText,
              url: href,
            });
          }
          return results;
        }
      );

      if (versions.length === 0) {
        logError(`  未找到任何版本: ${packagePath}`);
        return null;
      }

      // 取第一个（最新的稳定版）
      const latest = versions[0];
      log(`  最新版本: ${latest.version}`);
      return {
        version: latest.version,
        versionUrl: BASE_URL + latest.url,
      };
    } catch (e) {
      logError(`  解析版本列表失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 步骤 2: 从版本页面获取所有变体信息
   *
   * @param {string} versionUrl - 版本页面 URL
   * @returns {Array} 变体列表
   */
  async getVariants(versionUrl) {
    const ok = await this.navigateWithRetry(versionUrl);
    if (!ok) return [];

    try {
      // APKMirror 变体表格结构:
      // table.variants-table 或 div.table-row
      // 每行包含: 变体名 | 架构 | Android版本 | DPI | 下载链接

      // 方法 1: 尝试解析变体表格
      let variants = await this.page.$$eval(
        ".variants-table .table-row, .table-row.headerFont",
        (rows) => {
          const results = [];
          for (const row of rows) {
            // 跳过表头
            if (row.classList.contains("headerFont")) continue;

            const cells = row.querySelectorAll(".table-cell");
            if (cells.length < 4) continue;

            const link = row.querySelector("a.accent_color");
            if (!link) continue;

            results.push({
              label: cells[0]?.textContent?.trim() || "",
              arch: cells[1]?.textContent?.trim() || "",
              android: cells[2]?.textContent?.trim() || "",
              dpi: cells[3]?.textContent?.trim() || "",
              pageUrl: link.getAttribute("href"),
            });
          }
          return results;
        }
      );

      // 方法 2: 如果表格解析失败，尝试替代选择器
      if (variants.length === 0) {
        log("  尝试替代解析方式...");
        variants = await this.page.$$eval(
          ".listWidget .appRow",
          (rows) => {
            const results = [];
            for (const row of rows) {
              const link = row.querySelector("a.accent_color");
              if (!link) continue;

              const text = row.textContent || "";

              results.push({
                label: link.textContent?.trim() || "",
                arch: text,
                android: text,
                dpi: text,
                pageUrl: link.getAttribute("href"),
              });
            }
            return results;
          }
        );
      }

      log(`  找到 ${variants.length} 个变体`);
      return variants.map((v) => ({
        label: v.label,
        arch: extractArch(v.arch),
        minAndroid: parseAndroidVersion(v.android),
        dpi: extractDpi(v.dpi),
        pageUrl: v.pageUrl ? BASE_URL + v.pageUrl : null,
      }));
    } catch (e) {
      logError(`  解析变体列表失败: ${e.message}`);
      return [];
    }
  }

  /**
   * 步骤 3: 从变体详情页获取直接下载链接
   *
   * APKMirror 的下载流程:
   * 变体详情页 → 点击 "Download APK" → 下载确认页 → 真实下载链接
   *
   * @param {string} variantPageUrl - 变体详情页 URL
   * @returns {string|null} 直接下载链接
   */
  async getDirectDownloadUrl(variantPageUrl) {
    const ok = await this.navigateWithRetry(variantPageUrl);
    if (!ok) return null;

    try {
      // 第一步: 在详情页找到 "Download APK" 按钮
      // 选择器可能是 a.downloadButton 或包含特定文字的链接
      const downloadBtnSelectors = [
        'a.accent_bg.btn-flat.downloadButton',
        'a.downloadButton',
        'a[href*="download"]',
        '.card-with-tabs a.accent_bg',
      ];

      let downloadPageUrl = null;

      for (const selector of downloadBtnSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn) {
            const href = await btn.getAttribute("href");
            if (href && href.includes("download")) {
              downloadPageUrl = href.startsWith("http")
                ? href
                : BASE_URL + href;
              break;
            }
          }
        } catch {
          continue;
        }
      }

      if (!downloadPageUrl) {
        // 尝试直接在页面内容中查找下载链接
        downloadPageUrl = await this.page.$$eval("a", (links) => {
          for (const a of links) {
            const href = a.getAttribute("href") || "";
            const text = a.textContent || "";
            if (
              text.includes("Download APK") ||
              (href.includes("-download") && href.includes("/apk/"))
            ) {
              return href;
            }
          }
          return null;
        });

        if (downloadPageUrl && !downloadPageUrl.startsWith("http")) {
          downloadPageUrl = BASE_URL + downloadPageUrl;
        }
      }

      if (!downloadPageUrl) {
        logError("    未找到下载按钮");
        return null;
      }

      log(`    进入下载页: ${downloadPageUrl}`);
      await sleep(DELAY_BETWEEN_PAGES);

      // 第二步: 访问下载确认页
      const ok2 = await this.navigateWithRetry(downloadPageUrl);
      if (!ok2) return null;

      // 第三步: 在确认页找到真实下载链接
      // 通常是一个倒计时后出现的链接，或直接可见的下载按钮
      // 格式: /wp-content/themes/APKMirror/download.php?id=xxx&key=xxx

      // 等待下载链接出现（APKMirror 有 5 秒倒计时）
      log("    等待下载链接生成 (倒计时)...");
      await sleep(6000);

      // 尝试多种选择器找到最终下载链接
      const directUrl = await this.page.$$eval("a", (links) => {
        for (const a of links) {
          const href = a.getAttribute("href") || "";
          // APKMirror 直链格式
          if (href.includes("download.php?id=")) {
            return href;
          }
        }
        // 备选: 查找带有特定 rel 属性的链接
        for (const a of links) {
          const rel = a.getAttribute("rel") || "";
          const href = a.getAttribute("href") || "";
          if (rel.includes("nofollow") && href.includes("/wp-content/")) {
            return href;
          }
        }
        return null;
      });

      if (directUrl) {
        const fullUrl = directUrl.startsWith("http")
          ? directUrl
          : BASE_URL + directUrl;
        log(`    ✅ 获取直链成功`);
        return fullUrl;
      }

      // 最后尝试: 通过点击事件触发
      try {
        const clickBtn = await this.page.$(
          'a[rel="nofollow"][data-google-vignette="false"]'
        );
        if (clickBtn) {
          const href = await clickBtn.getAttribute("href");
          if (href) {
            const fullUrl = href.startsWith("http") ? href : BASE_URL + href;
            log(`    ✅ 通过点击获取直链成功`);
            return fullUrl;
          }
        }
      } catch {
        // 忽略
      }

      logError("    未找到直接下载链接");
      return null;
    } catch (e) {
      logError(`    获取直链失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 为一个目标组合筛选最佳变体
   */
  filterBestVariant(variants, target) {
    return variants.filter((v) => {
      // 架构匹配
      if (v.arch !== target.arch && v.arch !== "universal") return false;

      // Android 版本匹配
      const targetVersion = parseFloat(target.minAndroid);
      if (v.minAndroid > targetVersion) return false;

      return true;
    });
  }
}

// ============================================================
//  主流程
// ============================================================

async function main() {
  const configPath = path.join(__dirname, "..", "config", "packages.json");
  const outputPath = path.join(__dirname, "..", "variants.json");

  // 读取包配置
  if (!fs.existsSync(configPath)) {
    logError(`配置文件不存在: ${configPath}`);
    logError("请先创建 config/packages.json（参见 README）");
    process.exit(1);
  }

  const packagesConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const crawler = new ApkMirrorCrawler();

  const result = {
    config_version: 2,
    updated_at: new Date().toISOString().slice(0, 10),
    generated_by: "gms-config-crawler",
    packages: {},
  };

  try {
    await crawler.init();

    for (const pkg of packagesConfig.packages) {
      log(`\n${"=".repeat(60)}`);
      log(`处理包: ${pkg.name} (${pkg.package_name})`);
      log(`${"=".repeat(60)}`);

      // 1. 获取最新版本
      const latest = await crawler.getLatestVersion(pkg.apkmirror_path);
      if (!latest) {
        logError(`跳过 ${pkg.name}: 无法获取最新版本`);
        continue;
      }

      await sleep(DELAY_BETWEEN_PAGES);

      // 2. 获取所有变体
      const allVariants = await crawler.getVariants(latest.versionUrl);
      if (allVariants.length === 0) {
        logError(`跳过 ${pkg.name}: 无变体`);

        // 如果没有变体（GSF 通常只有一个 universal 包）
        // 尝试直接从版本页获取下载链接
        log(`  尝试作为单一 APK 处理...`);
        const directUrl = await crawler.getDirectDownloadUrl(
          latest.versionUrl
        );

        result.packages[pkg.id] = {
          name: pkg.name,
          package_name: pkg.package_name,
          version: latest.version,
          install_order: pkg.install_order,
          variants: [
            {
              variant_label: `${latest.version} / universal`,
              min_api: 21,
              max_api: null,
              abis: ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"],
              dpi: "nodpi",
              file_size_mb: pkg.approx_size_mb || 3,
              download_page_url: latest.versionUrl,
              direct_url: directUrl,
              sha256: null,
            },
          ],
        };
        continue;
      }

      // 3. 对每个目标组合，筛选并获取直链
      const packageVariants = [];
      const processedUrls = new Set();

      for (const target of TARGET_COMBINATIONS) {
        log(`\n  匹配目标: ${target.label}`);
        const matched = crawler.filterBestVariant(allVariants, target);

        if (matched.length === 0) {
          log(`  ⚠️ 未找到匹配变体`);
          continue;
        }

        // 取最佳匹配（第一个）
        const best = matched[0];

        // 避免重复处理同一个变体
        if (processedUrls.has(best.pageUrl)) {
          log(`  ↩️ 变体已处理过，跳过`);
          // 找到之前的结果复用
          const existing = packageVariants.find(
            (v) => v.download_page_url === best.pageUrl
          );
          if (existing) {
            // 更新 label 以反映更多适用场景
            packageVariants.push({
              ...existing,
              variant_label: `${latest.version} / ${target.label}`,
            });
          }
          continue;
        }

        if (!best.pageUrl) {
          log(`  ⚠️ 变体无页面链接`);
          continue;
        }

        processedUrls.add(best.pageUrl);

        log(`  最佳变体: ${best.label} (${best.arch}, Android ${best.minAndroid}+, ${best.dpi})`);

        await sleep(DELAY_BETWEEN_VARIANTS);

        // 获取直链
        const directUrl = await crawler.getDirectDownloadUrl(best.pageUrl);

        // 根据目标组合推算 API level
        const apiMap = { "14.0": 34, "13.0": 33, "12.0": 31, "11.0": 30 };
        const minApi = apiMap[target.minAndroid] || 30;

        packageVariants.push({
          variant_label: `${latest.version} / ${target.label}`,
          min_api: minApi,
          max_api: null,
          abis: target.arch === "universal"
            ? ["arm64-v8a", "armeabi-v7a"]
            : [target.arch],
          dpi: best.dpi,
          file_size_mb: pkg.approx_size_mb || 50,
          download_page_url: best.pageUrl,
          direct_url: directUrl,
          sha256: null,
        });

        log(
          `  结果: ${directUrl ? "✅ 有直链" : "⚠️ 无直链（将回退到网页引导）"}`
        );
      }

      result.packages[pkg.id] = {
        name: pkg.name,
        package_name: pkg.package_name,
        version: latest.version,
        install_order: pkg.install_order,
        variants: packageVariants,
      };
    }

    // 4. 写入输出文件
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
    log(`\n✅ 已生成: ${outputPath}`);

    // 统计
    let totalVariants = 0;
    let withDirectUrl = 0;
    for (const pkg of Object.values(result.packages)) {
      for (const v of pkg.variants) {
        totalVariants++;
        if (v.direct_url) withDirectUrl++;
      }
    }
    log(`   总变体数: ${totalVariants}`);
    log(`   有直链: ${withDirectUrl}`);
    log(`   无直链: ${totalVariants - withDirectUrl}`);
  } catch (e) {
    logError(`致命错误: ${e.message}`);
    console.error(e);
    process.exit(1);
  } finally {
    await crawler.close();
  }
}

main();
