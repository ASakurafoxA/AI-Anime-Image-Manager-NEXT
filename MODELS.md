# 模型文件怎么拿

本仓库**不含模型权重**：GitHub 单文件硬上限 **100 MB**，而这里最大的几个（WD14 的 `model.onnx` 361 MB、
SigLIP 的文字塔 106 MB、PixAI 的 onnx 1.86 GB）都放不下，即便塞进 Git LFS，免费额度（1 GB 存储 / 1 GB 月流量）
也会被一次 clone 用光。所以仓库里只放**来源链接 + SHA256**，模型自己下（或走 Releases / 网盘）。

小文件（tokenizer / vocab / `zh_names.csv` / `config.json` 等 17 个）**已经在仓库里**，不用另找。

## 下载后放到哪

全部放进 **`<图库>\models\`**，保持下面的相对路径即可 —— 例如：

```
<图库>\models\SmilingWolf\wd-vit-tagger-v3\model.onnx
<图库>\models\Xenova\siglip-base-patch16-224\onnx\vision_model_quantized.onnx
...
```

图库位置见 `%APPDATA%\AI Anime Image Manager\app-config.json` 里的 `dataPath`。

## 需要的大文件

| 放到 `<图库>\models\` 下 | 大小 | SHA256 | 来源 |
|---|---|---|---|
| `SmilingWolf\wd-vit-tagger-v3\model.onnx` | 361.0 MB | `6d1bef6b8d319838133489014666f368e9bd63c9a7b475ee5cb1bd557a10f916` | [SmilingWolf/wd-vit-tagger-v3](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3) |
| `Xenova\siglip-base-patch16-224\onnx\vision_model_quantized.onnx` | 94.9 MB | `ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058` | [Xenova/siglip-base-patch16-224](https://huggingface.co/Xenova/siglip-base-patch16-224) |
| `Xenova\siglip-base-patch16-224\onnx\text_model_quantized.onnx` | 106.3 MB | `ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2` | 同上 |
| `Xenova\opus-mt-zh-en\onnx\encoder_model_quantized.onnx` | 50.4 MB | `84d5e171b626bc8b6b220d022ac58696e9528c25deeacca62b5cbf4364547a99` | [Xenova/opus-mt-zh-en](https://huggingface.co/Xenova/opus-mt-zh-en) |
| `Xenova\opus-mt-zh-en\onnx\decoder_model_merged_quantized.onnx` | 57.4 MB | `c6b7f04ff1ba0fbd1bf6852599b4c0cad6fe512d57cd887f44ef36cf705424cb` | 同上 |
| `face\face_recognition_sface_2021dec.onnx` | 36.9 MB | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | [opencv_zoo → face_recognition_sface](https://github.com/opencv/opencv_zoo/blob/main/models/face_recognition_sface/README.md) |
| `face\face_detection_yunet_2023mar.onnx` | 0.2 MB | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | [opencv_zoo → face_detection_yunet](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/README.md) —— **这一份已在仓库里** ✓ |

> 注意 ONNX 文件名/量化方式要对得上：SigLIP 与 opus 用的是 **Xenova 的 `*_quantized.onnx`**；
> WD14 用的是 **SmilingWolf 原仓的 `model.onnx`**（非 quantized）；人脸两个来自 OpenCV Zoo 的 ONNX。

## 校验

```powershell
Get-FileHash "<刚下载的文件>" -Algorithm SHA256
```

哈希与上表不一致就别用（可能是别的版本/量化方式，会直接导致标签或向量错位）。

## 许可

各模型的权重各自遵循其原始许可（SmilingWolf / Xenova / OpenCV Zoo / PixAI 官方仓），请自行确认后再分发。
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

> **网盘链接（PixAI 模型）**：<https://pan.baidu.com/s/1pQvKSz0p1-cRJUQvngDasw?pwd=6666>　提取码：`6666`
> 其余几个（WD14 / SigLIP / opus / 人脸）都可以直接走官方源，不必放网盘。