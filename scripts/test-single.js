/**
 * 快速测试脚本
 *
 * 用法:
 *   node scripts/test-single.js <APKMirror URL>
 *
 * 支持三种 URL 类型:
 *   1. 包索引页:   .../apk/google-inc/google-services-framework/
 *   2. 版本发布页: .../google-services-framework-14.x.x-release/
 *   3. 变体详情页: .../google-services-framework-14.x.x-release/google-services-framework-...-download/
 *
 * 示例:
 *   node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-services-framework/"
 *   node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-play-services/google-play-services-25-6-31-release/"
 */

const { chromium } = require("playwright");

const BASE_URL = "https://www.apkmirror.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判断当前 URL 的类型 */
function detectUrlType(url) {
  // 变体详情页：URL 中包含两段 slug，最后一段通常含 "-android-apk-download" 或 "-apks-download"
  if (/-(?:android-apk|apks|apk)-download\/?$/.test(url)) {
    return "variant";
  }
  // 版本发布页：URL 结尾含 "-release/"
  if (/-release\/?$/.test(url)) {
    return "release";
  }
  // 包索引页
  return "package";
}

async function testSingleUrl(targetUrl) {
  const urlType = detectUrlType(targetUrl);
  const typeLabel = { package: "包索引页", release: "版本发布页", variant: "变体详情页" }[urlType];
  console.log(`\n🔍 测试 URL: ${targetUrl}`);
  console.log(`   检测到类型: ${typeLabel}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  try {
    // ──────────────────────────────────────────────
    // 步骤 1: 访问目标页面
    // ──────────────────────────────────────────────
    console.log("1️⃣  访问页面...");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const title = await page.title();
    console.log(`   页面标题: ${title}`);

    // 检测 Cloudflare
    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      console.log("   ⚠️  Cloudflare challenge，等待最多 30 秒...");
      await page.waitForFunction(
        () => !document.title.includes("Just a moment") && !document.title.includes("Attention Required"),
        { timeout: 30000 }
      );
      console.log(`   通过 Cloudflare，新标题: ${await page.title()}`);
    }

    // ──────────────────────────────────────────────
    // 检测 404
    // ──────────────────────────────────────────────
    if (title.toLowerCase().includes("page not found") || title.toLowerCase().includes("404")) {
      console.log("\n❌ 页面不存在 (404)\n");
      console.log("   可能原因:");
      console.log("   • URL 中的版本号有误（APKMirror 已下架或从未收录该版本）");
      console.log("   • URL 格式错误（多了或少了路径段）\n");
      console.log("   建议操作:");
      console.log(`   1. 先访问包索引页，找到实际存在的版本：`);
      const packagePageHint = targetUrl.replace(/\/[^/]+-release\/?$/, "/").replace(/\/[^/]+-(?:android-apk|apks|apk)-download\/?$/, "/");
      console.log(`      ${packagePageHint}`);
      console.log("   2. 复制真实版本页 URL 后重新运行本脚本\n");
      await page.screenshot({ path: "/tmp/debug-404.png", fullPage: false });
      console.log("   截图已保存: /tmp/debug-404.png");
      return;
    }

    // ──────────────────────────────────────────────
    // 步骤 2: 根据页面类型执行不同逻辑
    // ──────────────────────────────────────────────
    if (urlType === "package") {
      await handlePackagePage(page);
    } else if (urlType === "release") {
      await handleReleasePage(page, targetUrl);
    } else {
      await handleVariantPage(page, targetUrl);
    }

  } catch (e) {
    console.error(`\n❌ 错误: ${e.message}`);
    await page.screenshot({ path: "/tmp/debug-error.png" }).catch(() => {});
    console.log("   截图已保存: /tmp/debug-error.png");
  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────────────────────
// 包索引页：列出前 5 个可用版本
// ──────────────────────────────────────────────────────────
async function handlePackagePage(page) {
  console.log("\n2️⃣  包索引页 - 获取可用版本列表...\n");

  const versions = await page.$$eval(".listWidget .appRow", (rows) => {
    return rows.slice(0, 8).map((row) => {
      const link = row.querySelector("h5.appRowTitle a, .appRowTitle a");
      return link
        ? { version: link.textContent.trim(), url: link.getAttribute("href") }
        : null;
    }).filter(Boolean);
  });

  if (versions.length === 0) {
    console.log("   ❌ 未找到版本列表，页面结构可能已变化");
    await page.screenshot({ path: "/tmp/debug-package.png", fullPage: true });
    console.log("   截图已保存: /tmp/debug-package.png");
    return;
  }

  console.log(`   找到 ${versions.length} 个版本（显示前 8 个）:\n`);
  for (const v of versions) {
    console.log(`   • ${v.version}`);
    console.log(`     ${BASE_URL}${v.url}`);
  }
  console.log(`\n   💡 复制上方版本 URL，重新运行脚本以测试该版本。`);
}

// ──────────────────────────────────────────────────────────
// 版本发布页：列出所有变体
// ──────────────────────────────────────────────────────────
async function handleReleasePage(page, pageUrl) {
  console.log("\n2️⃣  版本发布页 - 获取变体列表...\n");

  // 优先：从 variants-table 中读取每行的 arch/android/dpi 和下载页链接
  let variants = await page.$$eval(
    ".variants-table .table-row",
    (rows) => {
      const results = [];
      for (const row of rows) {
        if (row.classList.contains("headerFont")) continue;
        const cells = row.querySelectorAll(".table-cell");
        if (cells.length < 2) continue;
        // 链接通常在第一个 cell 的 a.accent_color，或行内任意 a 指向 -download/
        const link = row.querySelector('a[href*="-download"]') ||
                     row.querySelector("a.accent_color");
        if (!link) continue;
        results.push({
          label: cells[0]?.textContent?.trim() || link.textContent?.trim() || "",
          arch:  cells[1]?.textContent?.trim() || "",
          android: cells[2]?.textContent?.trim() || "",
          dpi:   cells[3]?.textContent?.trim() || "",
          url:   link.getAttribute("href"),
        });
      }
      return results;
    }
  );

  // 备选：直接扫描页面内所有指向 *-download/ 或 *-apk-download/ 的链接
  if (variants.length === 0) {
    console.log("   variants-table 未找到，尝试扫描 -download 链接...");
    variants = await page.$$eval("a", (links) =>
      links
        .filter((a) => {
          const href = a.getAttribute("href") || "";
          return /-(android-apk|apks|apk)-download\/?$/.test(href) ||
                 (href.includes("-download/") && href.includes("/apk/"));
        })
        .map((a) => ({
          label: a.textContent?.trim() || a.getAttribute("href"),
          arch: "",
          android: "",
          dpi: "",
          url: a.getAttribute("href"),
        }))
        .filter((v, i, arr) =>
          arr.findIndex((x) => x.url === v.url) === i  // 去重
        )
    );
  }

  if (variants.length === 0) {
    console.log("   ⚠️  未找到变体列表");
    console.log("   可能原因：该包只有单一 APK（如 GSF），或页面结构已改变");

    console.log("\n   尝试查找直接下载按钮...");
    await handleVariantPage(page, pageUrl);
    return;
  }

  console.log(`   找到 ${variants.length} 个变体:\n`);
  for (const v of variants) {
    const parts = [v.arch, v.android, v.dpi].filter(Boolean).join(" / ");
    console.log(`   • ${v.label}${parts ? "  [" + parts + "]" : ""}`);
    if (v.url) console.log(`     ${v.url.startsWith("http") ? v.url : BASE_URL + v.url}`);
  }

  // 自动测试第一个变体的直链
  const first = variants.find((v) => v.url);
  if (first) {
    console.log(`\n   🔁 自动测试第一个变体的下载链接...`);
    const variantUrl = first.url.startsWith("http") ? first.url : BASE_URL + first.url;
    await page.goto(variantUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await handleVariantPage(page, variantUrl);
  }
}

// ──────────────────────────────────────────────────────────
// 变体详情页：获取直接下载链接
// ──────────────────────────────────────────────────────────
async function handleVariantPage(page, pageUrl) {
  console.log("\n3️⃣  变体详情页 - 查找下载按钮...\n");

  const pageInfo = await page.evaluate(() => {
    const allLinks = Array.from(document.querySelectorAll("a"));
    const downloadLinks = allLinks.filter((a) => {
      const href = a.getAttribute("href") || "";
      const text = a.textContent || "";
      return href.includes("download") || text.toLowerCase().includes("download");
    });
    return {
      totalLinks: allLinks.length,
      downloadLinks: downloadLinks.slice(0, 10).map((a) => ({
        text: a.textContent.trim().substring(0, 60),
        href: a.getAttribute("href"),
        className: a.className,
      })),
      hasVariantsTable: !!document.querySelector(".variants-table"),
      hasDownloadButton: !!document.querySelector(".downloadButton"),
      appRowCount: document.querySelectorAll(".appRow").length,
    };
  });

  console.log(`   总链接数: ${pageInfo.totalLinks}`);
  console.log(`   有变体表格: ${pageInfo.hasVariantsTable}`);
  console.log(`   有下载按钮: ${pageInfo.hasDownloadButton}`);
  console.log(`   appRow 数量: ${pageInfo.appRowCount}`);
  console.log(`\n   下载相关链接 (${pageInfo.downloadLinks.length}):`);
  for (const link of pageInfo.downloadLinks) {
    console.log(`     [${link.className || "no-class"}] "${link.text}" → ${link.href}`);
  }

  // 查找下载按钮
  const downloadBtnSelectors = [
    "a.accent_bg.btn-flat.downloadButton",
    "a.downloadButton",
    'a[href*="-download/"]',
    ".card-with-tabs a.accent_bg",
    "a.accent_bg",
  ];

  let downloadPageUrl = null;
  for (const selector of downloadBtnSelectors) {
    const btn = await page.$(selector);
    if (btn) {
      const href = await btn.getAttribute("href");
      const text = await btn.textContent();
      // 跳过页面内锚点（如 #downloads），只接受真正的路径/URL
      if (!href || href.startsWith("#")) continue;
      console.log(`\n   ✅ 找到按钮 [${selector}]: "${text?.trim()}" → ${href}`);
      downloadPageUrl = href.startsWith("http") ? href : BASE_URL + href;
      break;
    }
  }

  // 备选：从页面链接中直接找 -download/ 路径的 URL（变体下载确认页）
  if (!downloadPageUrl) {
    const candidates = await page.$$eval("a", (links) =>
      links
        .map((a) => a.getAttribute("href") || "")
        .filter((href) => href.includes("-download/") && href.includes("/apk/"))
    );
    if (candidates.length > 0) {
      downloadPageUrl = candidates[0].startsWith("http")
        ? candidates[0]
        : BASE_URL + candidates[0];
      console.log(`\n   ✅ 从链接扫描找到下载页: ${downloadPageUrl}`);
    }
  }

  if (!downloadPageUrl) {
    console.log("\n   ❌ 未找到下载按钮");
    await page.screenshot({ path: "/tmp/debug-page.png", fullPage: true });
    console.log("   截图已保存: /tmp/debug-page.png");

    if (pageInfo.hasVariantsTable) {
      console.log("\n   💡 提示: 当前是版本发布页（含变体表格），需要先进入具体变体页才能找到下载按钮。");
      console.log("   请在上方变体列表中选择一个 URL 重新运行脚本。");
    }
    return;
  }

  // 访问下载确认页
  console.log(`\n   进入下载确认页: ${downloadPageUrl}`);
  await page.goto(downloadPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // 等待倒计时（APKMirror 约 5 秒）
  console.log("   等待倒计时 (6 秒)...");
  await sleep(6000);

  // 查找直链
  const directUrl = await page.$$eval("a", (links) => {
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (href.includes("download.php?id=")) return href;
    }
    for (const a of links) {
      const rel = a.getAttribute("rel") || "";
      const href = a.getAttribute("href") || "";
      if (rel.includes("nofollow") && href.includes("/wp-content/")) return href;
    }
    return null;
  });

  if (directUrl) {
    const fullUrl = directUrl.startsWith("http") ? directUrl : BASE_URL + directUrl;
    console.log(`\n   ✅ 直链获取成功:\n   ${fullUrl}\n`);
  } else {
    console.log("\n   ❌ 未找到直接下载链接（可能被 Cloudflare 拦截或页面结构已变化）");

    const finalLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a"))
        .filter((a) => {
          const href = a.getAttribute("href") || "";
          return href.includes("wp-content") || href.includes("download");
        })
        .slice(0, 10)
        .map((a) => ({
          text: a.textContent.trim().substring(0, 40),
          href: a.getAttribute("href"),
          rel: a.getAttribute("rel"),
        }))
    );

    console.log("   确认页中的相关链接:");
    for (const link of finalLinks) {
      console.log(`     [rel=${link.rel}] "${link.text}" → ${link.href}`);
    }

    await page.screenshot({ path: "/tmp/debug-download.png", fullPage: true });
    console.log("   截图已保存: /tmp/debug-download.png");
  }
}

// ──────────────────────────────────────────────────────────
// 入口
// ──────────────────────────────────────────────────────────
const url = process.argv[2];
if (!url) {
  console.log("用法: node scripts/test-single.js <URL>\n");
  console.log("支持的 URL 类型:");
  console.log("  包索引页   → 列出所有可用版本");
  console.log("  版本发布页 → 列出所有变体，并自动测试第一个变体的直链");
  console.log("  变体详情页 → 直接测试下载链接获取\n");
  console.log("示例:");
  console.log('  node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-services-framework/"');
  console.log('  node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-play-services/google-play-services-25-6-31-release/"');
  process.exit(1);
}

testSingleUrl(url);
