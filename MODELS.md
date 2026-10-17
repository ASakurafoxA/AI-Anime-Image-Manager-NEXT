# 模型文件怎么拿

本仓库**不含模型权重**：GitHub 单文件硬上限 **100 MB**，而这里最大的几个（WD14 的 `model.onnx` 361 MB、
中文 CLIP 的 `model_quantized.onnx` 182 MB、PixAI 的 onnx 1.86 GB、CCIP 的 366 MB）都放不下，
即便塞进 Git LFS，免费额度（1 GB 存储 / 1 GB 月流量）也会被一次 clone 用光。
所以仓库里只放**来源链接 + SHA256**，模型自己下（或走 Releases / 网盘）。

小文件（tokenizer / vocab / `zh_names.csv` / `config.json` 等 17 个）**已经在仓库里**，不用另找。

## 下载后放到哪

全部放进 **`<图库>\models\`**，保持下面的相对路径即可 —— 例如：

```
<图库>\models\SmilingWolf\wd-vit-tagger-v3\model.onnx
<图库>\models\Xenova\chinese-clip-vit-base-patch16\onnx\model_quantized.onnx
<图库>\models\ccip\model_feat.onnx
...
```

图库位置见 `%APPDATA%\AI Anime Image Manager\app-config.json` 里的 `dataPath`。

## 需要的大文件

| 放到 `<图库>\models\` 下 | 大小 | SHA256 | 来源 |
|---|---|---|---|
| `SmilingWolf\wd-vit-tagger-v3\model.onnx` | 361.0 MB | `6d1bef6b8d319838133489014666f368e9bd63c9a7b475ee5cb1bd557a10f916` | [SmilingWolf/wd-vit-tagger-v3](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3) —— **WD 版 / 本地版用它打标** |
| `Xenova\chinese-clip-vit-base-patch16\onnx\model_quantized.onnx` | 182 MB | 见下方「本仓库自带」说明 | [Xenova/chinese-clip-vit-base-patch16](https://huggingface.co/Xenova/chinese-clip-vit-base-patch16) —— **语义搜索 / 以图搜图** |
| `ccip\model_feat.onnx`（+ `metrics.json`） | 366 MB | `8681DB576D6096C84B29700D9A31B9753771C97E3622A7B5091B8EB00F806130`（整包 zip） | [deepghs/ccip_onnx](https://huggingface.co/deepghs/ccip_onnx) —— **角色识别（可选，外置）** |

> 说明（2026-10-18 更新）：
> - **中文 CLIP 与 WD14 已随安装包提供**（本地版/WD 的 MSI 里两者都在；NEXT 的打标用 PixAI，WD14 不需要）。
>   只有从源码自己构建、或者要换模型时，才需要按上表手动补。
> - 本版只需要三类模型：**中文 CLIP**（语义搜索，随包）、**WD14 或 PixAI**（打标）、**CCIP**（角色识别，可选）✓
> - **CCIP 是可选模型**，三个版本共用同一个包 `CCIP模型-20261018.zip`（339 MB，含 `model_feat.onnx` + `metrics.json`），
>   网盘：<https://pan.baidu.com/s/1ZBRJIwIB7g1vuiTfoed4fA?pwd=6666>　提取码：`6666`　→ 解压到 `<图库>\models\ccip\` ✓
>   没有它角色识别会自动禁用并提示，其它功能不受影响。

## 校验

```powershell
Get-FileHash "<刚下载的文件>" -Algorithm SHA256
```

哈希与上表不一致就别用（可能是别的版本/量化方式，会直接导致标签或向量错位）。

## 许可

各模型的权重各自遵循其原始许可（2026-10-18 核实）：

| 模型 | 许可 | 依据 |
|---|---|---|
| 中文 CLIP（`OFA-Sys/chinese-clip-vit-base-patch16`，ONNX 版由 Xenova 转换） | **MIT** | 上游 GitHub 仓库 `OFA-Sys/Chinese-CLIP` 的 LICENSE（GitHub API 元数据 `spdx_id: MIT`）；**HF 模型卡未单独声明**，以仓库为准 |
| WD14 Tagger（`SmilingWolf/wd-vit-tagger-v3`） | **Apache License 2.0** | 模型卡声明 |
| CCIP（`deepghs/ccip_onnx`） | **MIT** | ONNX 仓库声明 |
| PixAI Tagger v1.0 | **未能核实**（官方仓只给 safetensors，公开 ONNX 来源不可考） | 建议只自用，不再分发；见下方 NEXT 专节 |

本项目的代码许可见 [LICENSE](LICENSE)（MIT）。
---

## 本版本（NEXT）额外需要的 PixAI 模型

| 放到 `<图库>\models\` 下 | 大小 | SHA256 | 来源 |
|---|---|---|---|
| `pixai-tagger-v1.0\pixai-tagger-v1.0.onnx` | 1,857.8 MB | `42901fd40c3147b2f34e8b0ff80c47b263cfd4a07d1a7154ccdcd19eaed27585` | 官方仓 [pixai-labs/pixai-tagger-v1.0](https://huggingface.co/pixai-labs/pixai-tagger-v1.0) |
| `pixai-tagger-v1.0\config.json` | 678 KB | `f8a19b38661c37dc5fd519f2137be70f6f897972021b4ebc17b7d35a0e27b9dd` | 官方仓（本仓库里**没有**这一份，它在模型压缩包里）|

⚠️ 关于这一份 onnx 的说明（重要）：

- 官方仓提供的是 **safetensors**，公开的 ONNX 镜像只有 **v0.9**（v1.0 没有可信的公开 ONNX）
- 本版实测使用的这份 ONNX **来源已不可考**，只能用上面的 SHA256 辨认
- 官方**再分发许可未能核实** → 建议仓库保持私有，模型只走网盘 / Releases
- 它是 FP32（`config.json` 里 `dtype: float32`）、1008×1008、30,877 类、`ViTDetCls`，1.86 GB

模型缺失时应用**不会静默**：日志会写 `PixAI 模型文件缺失：需要 <图库>\models\pixai-tagger-v1.0 下的 pixai-tagger-v1.0.onnx 与 config.json`，
表现只是打标与识图不可用，浏览/搜索/局域网照常。

---

## 现成打包（可选，来自网盘）

不想一个个从官方源下载的话，作者提供的打包：

| 包 | 内容 | 解压到 |
|---|---|---|
| `wd14-models.zip` | 上表全部文件（含 `models/` 这一层）| `<图库>` |
| `pixai-tagger-v1.0.zip`（仅 NEXT 需要）| `pixai-tagger-v1.0.onnx` + `config.json` | `<图库>\models` |

> **网盘链接（PixAI 模型）**：<https://pan.baidu.com/s/1ZBRJIwIB7g1vuiTfoed4fA?pwd=6666>　提取码：`6666`
> 其余模型（中文 CLIP / WD14）都可以直接走官方源，不必放网盘。