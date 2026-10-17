# AI Anime Image Manager NEXT

> **几万张动漫图扔进去，它自己认角色、打标签、找同一个人 —— 全程在本机跑，不上传一张图。**

<p align="center">
  <img src="screenshots/01-main-interface.png" width="860" alt="主界面"><br>
  <em>主界面：左边是标签树，右边是瀑布流，点标签就能筛图</em>
</p>

## 为什么值得用

- 🔒 **全部本地**：照片、标签、AI 特征都存你自己的硬盘；**断网也能用**，不上传任何图片。
- 🏷️ **动漫专用打标**：PixAI Tagger（词表 **30,877**）认角色、作品系列、画风、分级；
  标签落库是 **`中文 (english)`**，**中文英文都能搜**。
- 🎭 **认得出「同一个人」**：CCIP 特征把同一角色的图聚在一起，**跨图识别**；
  漏打标签的图也能找出来补上。
- ⚡ **快**：显卡加速（DirectML），7.7 万张全库算完角色特征约 **1.5 小时**（本机实测，你的机器可能不同）。
- 📱 **手机也能看**：开着电脑，手机浏览器就能浏览、搜索、看大图（只读）。

<p align="center">
  <img src="screenshots/02-tag-tree.png" width="420" alt="标签树">&nbsp;&nbsp;
  <img src="screenshots/04-web-gallery-desktop.png" width="420" alt="手机网页端">
</p>
<p align="center"><em>左：标签树（角色 / 通用二级分类）　右：网页端（局域网只读浏览）</em></p>

## 三步装好

| 步骤 | 做什么 |
|---|---|
| ① 装本体 | 双击 `AI Anime Image Manager NEXT-2.2.3-20261018.msi`（**378 MB**） |
| ② 放打标模型 | 把 PixAI 模型解压到 `<图库>\models\pixai-tagger-v1.0\`（约 1.7 GB） |
| ③ 打开 | 开始菜单启动 → 选一个图库文件夹（放你图片的目录） |

> **想用角色识别**再放一次 CCIP 模型（339 MB，三版共用）：见 [CCIP模型安装说明.md](CCIP模型安装说明.md)。
> 打标速度约 **0.59 秒/张**（本机实测）。

## 下载

| 内容 | 地址 |
|---|---|
| **安装包**（三个版本的 MSI） | <https://pan.baidu.com/s/1jDBvv4tL9v5_BgYhRDJcGQ?pwd=6666> 提取码 `6666` |
| **PixAI 打标模型**（只有 NEXT 需要，和 NEXT 安装包放同一处） | <https://pan.baidu.com/s/1ZBRJIwIB7g1vuiTfoed4fA?pwd=6666> 提取码 `6666` |
| **CCIP 角色识别模型**（三版共用，单独一份） | 见 [CCIP模型安装说明.md](CCIP模型安装说明.md) |

最新版和**历史版本**都在 [Releases](https://github.com/ASakurafoxA/AI-Anime-Image-Manager-NEXT/releases)（一版一个 tag，旧版不会被覆盖）。

## 三个版本怎么选

| 版本 | 打标模型 | 局域网/手机 | 状态 |
|---|---|---|---|
| 本地版（`AI-Anime-Image-Manager`） | WD14（在安装包里） | 无 | 已冻结 |
| **WD**（`AI-Anime-Image-Manager-WD`，原 LAN 版） | WD14（在安装包里） | **有** | 持续维护 |
| **NEXT**（本仓库） | **PixAI Tagger v1.0**（单独放） | **有** | 持续维护 |

## 文档

| 想了解 | 看哪 |
|---|---|
| 详细功能（打标规则、标签树、角色识别四步、查重、局域网） | [功能说明.md](功能说明.md) |
| 一步一步的操作手册 | [使用说明.md](使用说明.md) |
| 模型放哪、SHA256、许可 | [MODELS.md](MODELS.md) |
| 这一版改了什么 | [CHANGELOG.md](CHANGELOG.md) |
| 自己构建、提交规范 | [仓库维护规范.md](仓库维护规范.md) |

## 自己构建

```powershell
npm install
node node_modules/@electron-forge/cli/dist/electron-forge.js make --targets @electron-forge/maker-wix
```

> 从**纯 ASCII、尽量短**的路径构建（中文/空格路径会让 WiX 失败）；`package.json` 的 `description` 必须纯 ASCII。

## 许可

本项目代码 **MIT**（保留上游版权声明，见 [LICENSE](LICENSE)）；第三方模型各自遵循其许可（中文 CLIP = MIT、CCIP = MIT、PixAI 未核实 → 只自用），详见 [MODELS.md](MODELS.md)。
基于 [Uyoung666/ai-image-manager](https://github.com/Uyoung666/ai-image-manager) v2.2.3（MIT，© 2025 Luan Roger）修改。
