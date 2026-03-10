/**
 * 快速测试脚本
 *
 * 用法:
 *   node scripts/test-single.js <APKMirror变体页URL>
 *
 * 示例:
 *   node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-services-framework/google-services-framework-14-8692178-release/"
 *
 * 作用:
 *   对单个 URL 执行完整的直链获取流程，用于验证爬虫逻辑是否正常
 */

const { chromium } = require("playwright");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function testSingleUrl(targetUrl) {
  console.log(`\n🔍 测试 URL: ${targetUrl}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  try {
    // 步骤 1: 访问目标页面
    console.log("1️⃣  访问页面...");
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const title = await page.title();
    console.log(`   页面标题: ${title}`);

    // 检查 Cloudflare
    if (title.includes("Just a moment")) {
      console.log("   ⚠️ Cloudflare challenge，等待...");
      await page.waitForFunction(
        () => !document.title.includes("Just a moment"),
        { timeout: 30000 }
      );
      console.log(`   页面标题: ${await page.title()}`);
    }

    // 步骤 2: 查找页面上所有链接，分析结构
    console.log("\n2️⃣  分析页面结构...");

    const pageInfo = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll("a"));
      const downloadLinks = allLinks.filter((a) => {
        const href = a.getAttribute("href") || "";
        const text = a.textContent || "";
        return (
          href.includes("download") ||
          text.toLowerCase().includes("download") ||
          href.includes("download.php")
        );
      });

      return {
        totalLinks: allLinks.length,
        downloadLinks: downloadLinks.map((a) => ({
          text: a.textContent.trim().substring(0, 60),
          href: a.getAttribute("href"),
          class: a.className,
        })),
        hasVariantsTable:
          document.querySelector(".variants-table") !== null,
        hasDownloadButton:
          document.querySelector(".downloadButton") !== null,
        appRowCount: document.querySelectorAll(".appRow").length,
      };
    });

    console.log(`   总链接数: ${pageInfo.totalLinks}`);
    console.log(`   有变体表格: ${pageInfo.hasVariantsTable}`);
    console.log(`   有下载按钮: ${pageInfo.hasDownloadButton}`);
    console.log(`   appRow 数量: ${pageInfo.appRowCount}`);
    console.log(`\n   下载相关链接 (${pageInfo.downloadLinks.length}):`);
    for (const link of pageInfo.downloadLinks.slice(0, 10)) {
      console.log(`     [${link.class || "no-class"}] "${link.text}" → ${link.href}`);
    }

    // 步骤 3: 尝试获取直链
    console.log("\n3️⃣  尝试获取直接下载链接...");

    // 查找下载按钮
    const downloadBtnSelectors = [
      "a.accent_bg.btn-flat.downloadButton",
      "a.downloadButton",
      'a[href*="-download/"]',
      "a.accent_bg",
    ];

    let downloadPageUrl = null;
    for (const selector of downloadBtnSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        const href = await btn.getAttribute("href");
        const text = await btn.textContent();
        console.log(`   找到按钮 [${selector}]: "${text?.trim()}" → ${href}`);
        if (href) {
          downloadPageUrl = href.startsWith("http")
            ? href
            : "https://www.apkmirror.com" + href;
          break;
        }
      }
    }

    if (!downloadPageUrl) {
      console.log("   ❌ 未找到下载按钮");

      // 保存截图供调试
      await page.screenshot({ path: "/tmp/debug-page.png", fullPage: true });
      console.log("   截图已保存: /tmp/debug-page.png");
      return;
    }

    console.log(`\n   进入下载页: ${downloadPageUrl}`);
    await page.goto(downloadPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // 等待倒计时
    console.log("   等待倒计时 (6秒)...");
    await new Promise((r) => setTimeout(r, 6000));

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
      const fullUrl = directUrl.startsWith("http")
        ? directUrl
        : "https://www.apkmirror.com" + directUrl;
      console.log(`\n   ✅ 直链: ${fullUrl}`);
    } else {
      console.log("\n   ❌ 未找到直接下载链接");

      const finalPageInfo = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a"));
        return links
          .filter((a) => {
            const href = a.getAttribute("href") || "";
            return href.includes("wp-content") || href.includes("download");
          })
          .map((a) => ({
            text: a.textContent.trim().substring(0, 40),
            href: a.getAttribute("href"),
            rel: a.getAttribute("rel"),
          }));
      });

      console.log("   确认页链接:");
      for (const link of finalPageInfo) {
        console.log(`     [rel=${link.rel}] "${link.text}" → ${link.href}`);
      }

      await page.screenshot({ path: "/tmp/debug-download.png", fullPage: true });
      console.log("   截图已保存: /tmp/debug-download.png");
    }
  } catch (e) {
    console.error(`\n❌ 错误: ${e.message}`);
    await page.screenshot({ path: "/tmp/debug-error.png" }).catch(() => {});
  } finally {
    await browser.close();
  }
}

// 入口
const url = process.argv[2];
if (!url) {
  console.log("用法: node scripts/test-single.js <URL>");
  console.log("");
  console.log("示例:");
  console.log(
    '  node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-services-framework/google-services-framework-14-8692178-release/"'
  );
  process.exit(1);
}

testSingleUrl(url);
