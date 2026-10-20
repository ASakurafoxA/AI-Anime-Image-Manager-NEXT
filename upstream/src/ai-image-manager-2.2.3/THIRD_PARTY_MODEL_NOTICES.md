# Third-party model notices

## SigLIP Base Patch16-224

- Upstream model: `google/siglip-base-patch16-224`
- ONNX conversion: `Xenova/siglip-base-patch16-224`
- Purpose: local image/text embeddings for semantic search and automatic tags
- License: Apache License 2.0

The model weights are redistributed under the Apache License 2.0. A copy of
that license is included at `licenses/SigLIP-Apache-2.0.txt`.

Source:

- https://huggingface.co/google/siglip-base-patch16-224
- https://huggingface.co/Xenova/siglip-base-patch16-224

The model is provided without warranties or conditions of any kind. This
notice must remain with source and binary distributions that include the
SigLIP weights.

## OPUS-MT Chinese to English

- Upstream model: `Helsinki-NLP/opus-mt-zh-en`
- ONNX conversion: `Xenova/opus-mt-zh-en`
- Pinned conversion revision: `92737ae29cee287d5b7dc400c52afb9407207640`
- Purpose: local, offline Chinese-to-English query translation
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)

The model is based on the OPUS multilingual parallel corpus and was trained
by the Language Technology Research Group at the University of Helsinki.
The application does not send or persist translation queries.

Source:

- https://huggingface.co/Helsinki-NLP/opus-mt-zh-en
- https://huggingface.co/Xenova/opus-mt-zh-en
- https://creativecommons.org/licenses/by/4.0/

The required attribution and a link to the license are included at
`licenses/OPUS-MT-CC-BY-4.0.txt`.

## Anime Face Detection (deepghs/anime_face_detection)

- Upstream: `deepghs/anime_face_detection`, variant `face_detect_v1.4_s`
- Purpose: local, offline anime face detection (single class, bounding boxes)
- License: MIT

Added for the NEXT build (2026-10): replaces YuNet as the face detector because
YuNet is trained on real faces and missed most anime faces (measured 36.5% of
person images vs 99.5% for this model). It does not output landmarks, so the
recognition stage falls back to a bounding-box crop.

The model weights are redistributed under the MIT License. A copy of that
license is included at `licenses/AnimeFaceDetection-MIT.txt`.

Source:

- https://huggingface.co/deepghs/anime_face_detection
- https://github.com/deepghs/imgutils

## YuNet Face Detection (retained for rollback)

- Upstream: Shiqi Yu's libfacedetection training (YuNet)
- ONNX conversion: OpenCV Zoo `face_detection_yunet`
- Purpose: local, offline face detection with 5-point landmarks
- License: MIT

Retained so the NEXT build can be switched back by changing
`detection.architecture` to `"yunet"` in `src/services/ai/face-model-config.ts`
and the matching `DETECTOR` constant in `scripts/face-worker.mjs`.

The model weights are redistributed under the MIT License. A copy of that
license is included at `licenses/YuNet-MIT.txt`.

Source:

- https://github.com/ShiqiYu/libfacedetection
- https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet

## SFace Face Recognition

- Upstream: SFace — Sigmoid-Constrained Hypersphere Loss (Yaoyao Zhong)
- ONNX conversion: OpenCV Zoo `face_recognition_sface`
- Purpose: local, offline face embedding (128-d) for identity clustering
- License: Apache License 2.0

The model weights are redistributed under the Apache License 2.0. A copy of
that license is included at `licenses/SFace-Apache-2.0.txt`.

Source:

- https://github.com/zhongyy/SFace
- https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface

The model is provided without warranties or conditions of any kind. This
notice must remain with source and binary distributions that include the
SFace weights.


## PixAI Tagger v1.0

- Upstream model: PixAI Tagger v1.0 (six-category anime tagging)
- Purpose: local, offline image tagging (general / character / series / style / meta / rating)
- License: Apache License 2.0

The model weights are redistributed under the Apache License 2.0 and are shipped
as a separate download (`pixai-tagger-v1.0.zip`) because of their size. The model
is provided without warranties or conditions of any kind.

## WD14 Tagger (retained for rollback)

- Upstream model: `SmilingWolf/wd-vit-tagger-v3`
- Purpose: local, offline Danbooru-style image tagging (rollback path)
- License: Apache License 2.0

The model weights are redistributed under the Apache License 2.0. The model is
provided without warranties or conditions of any kind.

## Chinese-CLIP Base Patch16-224

- Upstream model: `OFA-Sys/chinese-clip-vit-base-patch16`
- ONNX conversion: `Xenova/chinese-clip-vit-base-patch16` (merged `model_quantized.onnx`)
- Purpose: local, offline Chinese-native image/text embeddings for semantic search
- License: **MIT** — as declared by the upstream **source repository**
  `OFA-Sys/Chinese-CLIP` (GitHub API metadata: `"license": {"spdx_id": "MIT"}`),
  verified **2026-10-18**

Attribution note (kept honest on purpose): the **Hugging Face model card** for
`OFA-Sys/chinese-clip-vit-base-patch16` does **not** spell out a license field, so
the license above is taken from the upstream **repository** that publishes the
model. The ONNX conversion (`Xenova/chinese-clip-vit-base-patch16`) is a format
conversion of the same weights and is redistributed here on the same terms.

This project ships these ONNX weights (≈183 MB, `model_quantized.onnx`) so that
Chinese semantic search works fully offline. If the upstream ever clarifies a
different license, this notice will be updated accordingly.

Sources:

- https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16
- https://github.com/OFA-Sys/Chinese-CLIP (repository LICENSE)
- https://api.github.com/repos/OFA-Sys/Chinese-CLIP (license metadata)

## CCIP (Character-Centric Image Proxy, ONNX)

- Upstream model: `deepghs/ccip-caformer_b36-24` (ONNX: `deepghs/ccip_onnx`)
- Purpose: local, offline 768-d character features for character recognition / clustering
- License: MIT (as declared by the ONNX model repository)

The ONNX weights are redistributed/offered as an optional external model under the
MIT license declared by `deepghs/ccip_onnx`. The model is provided without
warranties or conditions of any kind.

Source:

- https://huggingface.co/deepghs/ccip_onnx
- https://huggingface.co/deepghs/ccip-caformer_b36-24
