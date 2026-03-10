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
 * 例如 "Android 14.0+" → 14.0，"5.0+" → 5.0
 * 注意：避免将应用版本号（如 26.10.32）误识别为 Android 版本
 */
function parseAndroidVersion(text) {
  // 优先匹配 "Android X" 或 "Android X.Y" 格式（最可靠）
  const androidMatch = text.match(/android\s+(\d+(?:\.\d+)?)/i);
  if (androidMatch) return parseFloat(androidMatch[1]);

  // 匹配 "X.Y+" 格式（如 "5.0+"，APKMirror 常用）
  const plusMatch = text.match(/(\d+\.\d+)\+/);
  if (plusMatch) return parseFloat(plusMatch[1]);

  // 匹配 "minSdk X" 或 "API X" 格式
  const apiMatch = text.match(/(?:minSdk|api)\s*(\d+)/i);
  if (apiMatch) {
    // API level 转 Android 版本（近似）
    const api = parseInt(apiMatch[1]);
    if (api >= 34) return 14.0;
    if (api >= 33) return 13.0;
    if (api >= 31) return 12.0;
    if (api >= 30) return 11.0;
    if (api >= 21) return 5.0;
    return parseFloat((api / 10).toFixed(1));
  }

  return 0; // 未找到 → 不限制 Android 版本
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

        // 检查 404
        const finalTitle = await this.page.title();
        if (
          finalTitle.toLowerCase().includes("page not found") ||
          finalTitle.toLowerCase().includes("404")
        ) {
          logError(`  页面不存在 (404): ${url}`);
          return false;
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
   * 步骤 1: 获取某个包的全部稳定版本列表
   *
   * @param {string} packagePath - APKMirror 上的包路径
   * @returns {Array} [{version, versionUrl}]
   */
  async getVersionList(packagePath) {
    const url = `${BASE_URL}/apk/${packagePath}/`;
    const ok = await this.navigateWithRetry(url);
    if (!ok) return [];

    try {
      // 只选取属于本包的版本条目：版本 URL 必须以 /apk/<packagePath>/ 开头
      // 这样可以排除侧边栏"热门应用"等其他包的干扰
      const versions = await this.page.$$eval(
        ".listWidget .appRow",
        (rows, pkgPath) => {
          const results = [];
          for (const row of rows) {
            const link = row.querySelector("h5.appRowTitle a, .appRowTitle a");
            if (!link) continue;

            const href = link.getAttribute("href") || "";
            if (!href.startsWith(`/apk/${pkgPath}/`)) continue;

            const versionText = link.textContent.trim();
            const lower = versionText.toLowerCase();
            if (
              lower.includes("beta") ||
              lower.includes("alpha") ||
              lower.includes("wear") ||
              lower.includes("canary")
            ) {
              continue;
            }

            results.push({ version: versionText, url: href });
          }
          return results;
        },
        packagePath
      );

      if (versions.length === 0) {
        logError(`  未找到任何版本: ${packagePath}`);
        return [];
      }

      log(`  找到 ${versions.length} 个版本，最新: ${versions[0].version}`);
      return versions.map((v) => ({
        version: v.version,
        versionUrl: BASE_URL + v.url,
      }));
    } catch (e) {
      logError(`  解析版本列表失败: ${e.message}`);
      return [];
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
      // 方法 1: 解析 variants-table
      // 每行含: 变体名 | 架构 | Android 最低版本 | DPI
      let variants = await this.page.$$eval(
        ".variants-table .table-row",
        (rows) => {
          const results = [];
          for (const row of rows) {
            if (row.classList.contains("headerFont")) continue;

            const cells = row.querySelectorAll(".table-cell");
            // 查找指向 -download 页的链接（变体详情页链接）
            const link =
              row.querySelector('a[href*="-download"]') ||
              row.querySelector("a.accent_color");
            if (!link) continue;

            results.push({
              label: cells[0]?.textContent?.trim() || link.textContent?.trim() || "",
              arch: cells[1]?.textContent?.trim() || "",
              android: cells[2]?.textContent?.trim() || "",
              dpi: cells[3]?.textContent?.trim() || "",
              pageUrl: link.getAttribute("href"),
            });
          }
          return results;
        }
      );

      // 方法 2: 扫描当前发布页路径下的 *-download/ 子链接
      // 用发布页 URL 作前缀过滤，避免侧边栏其他包的链接干扰
      if (variants.length === 0) {
        log("  尝试扫描 -download 链接...");
        // 提取路径前缀，例如 /apk/google-inc/google-services-framework/google-services-framework-16-release/
        let releasePath = "";
        try {
          releasePath = new URL(versionUrl).pathname;
          if (!releasePath.endsWith("/")) releasePath += "/";
        } catch {}

        variants = await this.page.$$eval(
          "a",
          (links, basePath) => {
            const seen = new Set();
            const results = [];
            for (const a of links) {
              const href = a.getAttribute("href") || "";
              // 必须是当前发布页的子路径（排除侧边栏其他包的链接）
              if (basePath && !href.startsWith(basePath)) continue;
              // 必须是下载页链接
              if (
                !href.includes("-download/") &&
                !/-(?:android-apk|apks|apk)-download\/?$/.test(href)
              ) continue;

              const cleanHref = href.split("#")[0];
              if (seen.has(cleanHref)) continue;
              seen.add(cleanHref);

              // 尝试从最近的表格行或 appRow 中提取 arch/android/dpi 信息
              const row =
                a.closest("tr, .table-row, .appRow") || a.parentElement;
              const rowText = row ? row.textContent : "";

              results.push({
                label: a.textContent?.trim() || cleanHref,
                arch: rowText,
                android: rowText,
                dpi: rowText,
                pageUrl: cleanHref,
              });
            }
            return results;
          },
          releasePath
        );
      }

      const parsed = variants.map((v) => ({
        label: v.label,
        arch: extractArch(v.arch),
        minAndroid: parseAndroidVersion(v.android),
        dpi: extractDpi(v.dpi),
        pageUrl: v.pageUrl
          ? v.pageUrl.startsWith("http")
            ? v.pageUrl
            : BASE_URL + v.pageUrl
          : null,
      }));

      log(`  找到 ${parsed.length} 个变体`);
      for (const v of parsed) {
        log(`    • ${v.label} | arch=${v.arch} minAndroid=${v.minAndroid} dpi=${v.dpi}`);
      }
      return parsed;
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
        'a[href*="-download/"]',        // 变体详情页链接（含路径分隔符，排除 Twitter 等）
        'a[href*="download/?key="]',    // 下载确认页直接链接
        '.card-with-tabs a.accent_bg',
      ];

      let downloadPageUrl = null;

      for (const selector of downloadBtnSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn) {
            const href = await btn.getAttribute("href");
            // 跳过页面内锚点（如 #downloads、#file）
            if (!href || href.startsWith("#")) continue;
            if (href.includes("download")) {
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
        // 备选：扫描页面内所有链接，找 -download/ 或 download/?key= 格式
        downloadPageUrl = await this.page.$$eval("a", (links) => {
          for (const a of links) {
            const href = a.getAttribute("href") || "";
            const text = a.textContent || "";
            // 下载确认页格式: /apk/.../download/?key=xxx
            if (href.includes("/download/") && href.includes("?key=")) return href;
            // 含"Download APK"文字的链接
            if (text.includes("Download APK") && href.includes("/apk/")) return href;
            // 变体下载页路径
            if (href.includes("-download/") && href.includes("/apk/")) return href;
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
      // 架构匹配：精确匹配、universal 或 unknown（单一 APK 包无架构标注）
      const archOk =
        v.arch === target.arch ||
        v.arch === "universal" ||
        v.arch === "unknown";
      if (!archOk) return false;

      // Android 版本匹配：变体的最低要求不能高于目标版本
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

      // 1. 获取全部版本列表（由新到旧）
      const versionList = await crawler.getVersionList(pkg.apkmirror_path);
      if (versionList.length === 0) {
        logError(`跳过 ${pkg.name}: 无法获取版本列表`);
        continue;
      }

      await sleep(DELAY_BETWEEN_PAGES);

      // 变体缓存：同一个版本页只拉取一次
      const variantsCache = new Map(); // versionUrl → variants[]

      // 2. 对每个目标组合，从最新版本开始逐一尝试
      const packageVariants = [];
      const processedUrls = new Set(); // 已获取直链的变体页URL（避免重复请求）

      for (const target of TARGET_COMBINATIONS) {
        log(`\n  匹配目标: ${target.label}`);

        let foundMatch = false;

        for (const versionInfo of versionList) {
          // 获取该版本的变体列表（优先用缓存）
          let allVariants = variantsCache.get(versionInfo.versionUrl);
          if (!allVariants) {
            await sleep(DELAY_BETWEEN_PAGES);
            allVariants = await crawler.getVariants(versionInfo.versionUrl);
            variantsCache.set(versionInfo.versionUrl, allVariants);
          }

          if (allVariants.length === 0) continue;

          const matched = crawler.filterBestVariant(allVariants, target);
          if (matched.length === 0) {
            log(`    版本 ${versionInfo.version}: 无匹配变体，尝试更旧版本...`);
            continue;
          }

          const best = matched[0];

          // 同一变体已处理过：直接复用结果
          if (processedUrls.has(best.pageUrl)) {
            log(`  ↩️ 变体已处理过，复用结果`);
            const existing = packageVariants.find(
              (v) => v.download_page_url === best.pageUrl
            );
            if (existing) {
              packageVariants.push({
                ...existing,
                variant_label: `${versionInfo.version} / ${target.label}`,
              });
            }
            foundMatch = true;
            break;
          }

          if (!best.pageUrl) {
            log(`  ⚠️ 变体无页面链接`);
            continue;
          }

          processedUrls.add(best.pageUrl);
          log(`  最佳变体: ${best.label} (版本: ${versionInfo.version}, arch=${best.arch}, Android ${best.minAndroid}+, ${best.dpi})`);

          await sleep(DELAY_BETWEEN_VARIANTS);

          // 获取直链
          const directUrl = await crawler.getDirectDownloadUrl(best.pageUrl);

          const apiMap = { "14.0": 34, "13.0": 33, "12.0": 31, "11.0": 30 };
          const minApi = apiMap[target.minAndroid] || 30;

          packageVariants.push({
            variant_label: `${versionInfo.version} / ${target.label}`,
            version: versionInfo.version,
            min_api: minApi,
            max_api: null,
            abis:
              target.arch === "universal" || best.arch === "unknown"
                ? ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"]
                : [target.arch],
            dpi: best.dpi,
            file_size_mb: pkg.approx_size_mb || 50,
            download_page_url: best.pageUrl,
            direct_url: directUrl,
            sha256: null,
          });

          log(`  结果: ${directUrl ? "✅ 有直链" : "⚠️ 无直链（将回退到网页引导）"}`);
          foundMatch = true;
          break; // 找到匹配，不再尝试更旧版本
        }

        if (!foundMatch) {
          log(`  ⚠️ 未找到匹配变体（已遍历 ${versionList.length} 个版本）`);
        }
      }

      // 如果所有目标都没匹配到变体，尝试用最新版本直接获取
      if (packageVariants.length === 0 && versionList.length > 0) {
        log(`  尝试作为单一 APK 处理（最新版本）...`);
        const latestInfo = versionList[0];
        const directUrl = await crawler.getDirectDownloadUrl(
          latestInfo.versionUrl
        );
        packageVariants.push({
          variant_label: `${latestInfo.version} / universal`,
          version: latestInfo.version,
          min_api: 21,
          max_api: null,
          abis: ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"],
          dpi: "nodpi",
          file_size_mb: pkg.approx_size_mb || 3,
          download_page_url: latestInfo.versionUrl,
          direct_url: directUrl,
          sha256: null,
        });
      }

      result.packages[pkg.id] = {
        name: pkg.name,
        package_name: pkg.package_name,
        version: versionList[0].version,
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
