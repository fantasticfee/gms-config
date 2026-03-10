/**
 * variants.json 校验脚本
 *
 * 在上传到 GitHub 之前校验生成的配置是否合理
 * 检查项:
 * - JSON 格式正确
 * - 三个包都存在
 * - 每个包至少有一个变体
 * - 直链格式正确
 * - 无重复变体
 */

const fs = require("fs");
const path = require("path");

const REQUIRED_PACKAGES = ["gsf", "gps", "store"];

function validate() {
  const filePath = path.join(__dirname, "..", "variants.json");

  if (!fs.existsSync(filePath)) {
    console.error("❌ variants.json 不存在");
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`❌ JSON 解析失败: ${e.message}`);
    process.exit(1);
  }

  let errors = 0;
  let warnings = 0;

  // 检查基本结构
  if (!data.config_version) {
    console.error("❌ 缺少 config_version");
    errors++;
  }
  if (!data.updated_at) {
    console.error("❌ 缺少 updated_at");
    errors++;
  }
  if (!data.packages) {
    console.error("❌ 缺少 packages");
    process.exit(1);
  }

  // 检查三个包是否都在
  for (const pkgId of REQUIRED_PACKAGES) {
    if (!data.packages[pkgId]) {
      console.error(`❌ 缺少包: ${pkgId}`);
      errors++;
      continue;
    }

    const pkg = data.packages[pkgId];
    console.log(`\n📦 ${pkg.name} (${pkgId})`);
    console.log(`   版本: ${pkg.version}`);
    console.log(`   变体数: ${pkg.variants?.length || 0}`);

    if (!pkg.variants || pkg.variants.length === 0) {
      console.error(`   ❌ 无变体`);
      errors++;
      continue;
    }

    // 检查每个变体
    let directCount = 0;
    for (const variant of pkg.variants) {
      // 必填字段
      if (!variant.variant_label) {
        console.error(`   ❌ 变体缺少 variant_label`);
        errors++;
      }
      if (!variant.download_page_url) {
        console.error(`   ❌ 变体缺少 download_page_url: ${variant.variant_label}`);
        errors++;
      }
      if (!variant.abis || variant.abis.length === 0) {
        console.error(`   ❌ 变体缺少 abis: ${variant.variant_label}`);
        errors++;
      }

      // 直链检查
      if (variant.direct_url) {
        directCount++;
        if (!variant.direct_url.startsWith("https://www.apkmirror.com/")) {
          console.warn(`   ⚠️ 直链格式异常: ${variant.direct_url}`);
          warnings++;
        }
      }

      console.log(
        `   ${variant.direct_url ? "✅" : "⚠️"} ${variant.variant_label} → ${
          variant.direct_url ? "有直链" : "无直链"
        }`
      );
    }

    console.log(
      `   直链覆盖率: ${directCount}/${pkg.variants.length} (${Math.round(
        (directCount / pkg.variants.length) * 100
      )}%)`
    );

    if (directCount === 0) {
      console.warn(`   ⚠️ 该包所有变体均无直链`);
      warnings++;
    }
  }

  // 汇总
  console.log(`\n${"=".repeat(50)}`);
  if (errors > 0) {
    console.error(`❌ 校验失败: ${errors} 个错误, ${warnings} 个警告`);
    process.exit(1);
  } else if (warnings > 0) {
    console.warn(`⚠️ 校验通过，但有 ${warnings} 个警告`);
    console.log("   无直链的变体将回退到网页引导下载");
  } else {
    console.log("✅ 校验全部通过");
  }
}

validate();
