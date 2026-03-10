# GMS Config - APKMirror 爬虫服务

自动从 APKMirror 获取 Google 三件套的最新版本和直接下载链接，生成 `variants.json` 供 GMS 安装助手 App 使用。

## 工作原理

```
┌─────────────────────────────────────────────────┐
│            GitHub Actions (每天定时)              │
│                                                   │
│  1. 启动 Playwright 浏览器                        │
│  2. 访问 APKMirror，获取三件套最新版本             │
│  3. 遍历每个版本的所有变体                         │
│  4. 模拟点击，获取直接下载链接                     │
│  5. 生成 variants.json                            │
│  6. 自动 commit & push                            │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│    variants.json (托管在 GitHub)                  │
│                                                   │
│    GMS App 启动时拉取此文件                        │
│    → 获取适配当前设备的 APK 直链                   │
│    → 用户点击即下载，无需手动找版本                │
└─────────────────────────────────────────────────┘
```

## 快速开始

### 1. 本地运行（首次测试）

```bash
# 克隆仓库
git clone https://github.com/YOUR_USERNAME/gms-config.git
cd gms-config

# 安装依赖
npm install

# 安装 Playwright 浏览器（约 200MB）
npx playwright install chromium --with-deps

# 先用单个 URL 测试爬虫是否正常工作
node scripts/test-single.js "https://www.apkmirror.com/apk/google-inc/google-services-framework/google-services-framework-14-8692178-release/"

# 如果测试通过，运行完整爬虫
npm run crawl

# 校验生成的结果
npm run validate
```

### 2. 部署到 GitHub Actions（自动化）

```bash
# 推送到 GitHub
git add .
git commit -m "init: crawler service"
git push origin main

# 去 GitHub 仓库 → Settings → Actions → General
# 确保 "Allow GitHub Actions to create and approve pull requests" 已开启
# 确保 Workflow permissions 设为 "Read and write permissions"

# 手动触发第一次执行:
# GitHub 仓库 → Actions → Update GMS Variants → Run workflow
```

之后爬虫会每天北京时间 10:00 自动运行。

### 3. 对接 Flutter App

修改 App 中 `version_matcher.dart` 的 `_configUrl`：

```dart
static const _configUrl =
    'https://raw.githubusercontent.com/YOUR_USERNAME/gms-config/main/variants.json';
```

## 项目结构

```
gms-config/
├── .github/workflows/
│   └── update-variants.yml    # GitHub Actions 自动化配置
├── config/
│   └── packages.json          # 目标包定义（改这个来增减爬取目标）
├── scripts/
│   ├── crawl.js               # 核心爬虫脚本
│   ├── validate.js            # 结果校验脚本
│   └── test-single.js         # 单 URL 测试工具
├── variants.json              # 【自动生成】App 读取的配置文件
├── package.json
└── README.md
```

## variants.json 格式说明

```jsonc
{
  "config_version": 2,
  "updated_at": "2025-03-10",
  "packages": {
    "gsf": {
      "name": "Google Services Framework",
      "package_name": "com.google.android.gsf",
      "version": "14-8692178",
      "install_order": 1,
      "variants": [
        {
          "variant_label": "14-8692178 / universal",
          "min_api": 21,           // 最低支持的 API level
          "max_api": null,         // null 表示无上限
          "abis": ["arm64-v8a", "armeabi-v7a"],
          "dpi": "nodpi",
          "file_size_mb": 3,
          "download_page_url": "https://www.apkmirror.com/apk/...",   // 网页备用
          "direct_url": "https://www.apkmirror.com/wp-content/themes/APKMirror/download.php?id=xxx&key=xxx",  // 直链
          "sha256": null
        }
      ]
    },
    "gps": { ... },
    "store": { ... }
  }
}
```

App 侧的匹配逻辑：
1. 读取设备的 `apiLevel` 和 `cpuArch`
2. 对每个包，筛选 `min_api <= 设备API <= max_api` 且 `abis` 包含设备架构的变体
3. 优先使用 `direct_url` 直接下载
4. 如果 `direct_url` 为 null 或失效，回退到打开 `download_page_url` 网页

## 常见问题

### 爬虫被 Cloudflare 拦截怎么办？

爬虫已内置多层应对：
- 使用真实浏览器（Playwright Chromium），不是简单的 HTTP 请求
- 伪装了 User-Agent 和浏览器指纹
- 移除了 webdriver 标记
- 请求之间有 3-5 秒间隔

如果仍然被拦截，可以尝试：
1. 增大 `DELAY_BETWEEN_PAGES` 和 `DELAY_BETWEEN_VARIANTS` 的值
2. 在 `crawl.js` 中切换为 `headless: false` 本地调试（可以手动过验证码）
3. 使用代理（在 GitHub Actions 的环境变量中设置 `PROXY_URL`）

### 直链的有效期是多久？

APKMirror 的直链通常在 24-48 小时内有效。因此建议每天更新一次。如果直链失效，App 会自动回退到网页引导，不影响使用。

### 如何添加新的设备适配规则？

编辑 `crawl.js` 顶部的 `TARGET_COMBINATIONS` 数组：

```javascript
const TARGET_COMBINATIONS = [
  // 增加一条规则
  { arch: "x86_64", minAndroid: "13.0", label: "x86_64 / Android 13+ (模拟器)" },
];
```

### 如何只更新某一个包？

目前不支持单独更新。但你可以修改 `config/packages.json`，临时注释掉不需要更新的包。

### GitHub Actions 运行超时

默认超时 30 分钟。如果包变体很多，爬取时间可能较长。可以在 workflow 中调整：

```yaml
timeout-minutes: 45
```

## 维护建议

- **每月检查一次** Actions 运行日志，确认爬虫正常工作
- 如果 APKMirror 改版导致选择器失效，用 `test-single.js` 调试，更新 `crawl.js` 中的选择器
- 关注 Google 发布的重大 GMS 更新（尤其是需要新 API level 的版本）
- 保持 `config/packages.json` 中的 `approx_size_mb` 大致准确
