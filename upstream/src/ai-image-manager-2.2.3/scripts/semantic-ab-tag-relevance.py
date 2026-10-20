# -*- coding: utf-8 -*-
"""
用 WD14 标签给两套排序打一个**客观相关度分**。

查询词：戴着耳机坐在屋里的少女
拆成三个可被 WD14 标签验证的概念：
  · 耳机  (headphones 家族)
  · 屋里  (indoors 家族)
  · 少女  (1girl / solo)

对每个模型的 Top-K 计算：
  · 硬指标  耳机命中率 = Top-K 里带耳机标签（confidence>=0.35）的比例
  · 软指标  平均相关度 = mean( 0.55*耳机 + 0.30*室内 + 0.15*少女 )
取每个家族里置信度最高的那个标签作为该家族得分。
"""

import json
import sqlite3
from pathlib import Path

DB = "file:F:/AI Anime Image Manager NEXT/data/ai-image-manager.db?mode=ro"
OUT = Path(r"F:\DSH工作区\AI Anime Image Manager NEXT\semantic-ab-out")

HEADPHONE_LIKE = (
    "headphones", "earphones", "headset",
    "cat_ear_headphones", "animal_ear_headphones", "rabbit_ear_headphones",
    "wireless_earphones", "unworn_headphones", "holding_headphones",
    "holding_earphones", "hands_on_headphones", "hand_on_headphones",
    "adjusting_headphones", "headphones_around_neck", "headphones_over_headwear",
    "behind-the-head_headphones", "shared_earphones",
)
INDOOR_LIKE = (
    "indoors", "bedroom", "otaku_room", "messy_room", "hotel_room", "clubroom",
)
GIRL_LIKE = ("1girl", "solo")

HP_THRESHOLD = 0.35  # 认定"确实戴着/带着耳机"的置信度门槛


def english_name(name: str) -> str:
    """标签名形如 '耳机 (headphones)'，取括号里的英文；没有括号就用整串。"""
    if "(" in name and name.rstrip().endswith(")"):
        return name[name.rfind("(") + 1 : -1].strip().lower()
    return name.strip().lower()


def main():
    con = sqlite3.connect(DB, uri=True)
    cur = con.cursor()

    # 1) 找出三个家族对应的 tag_id
    fam = {}
    for tag_id, name in cur.execute("select id, name from tags"):
        eng = english_name(name)
        if eng in HEADPHONE_LIKE:
            fam.setdefault("headphones", set()).add(tag_id)
        elif eng in INDOOR_LIKE:
            fam.setdefault("indoors", set()).add(tag_id)
        elif eng in GIRL_LIKE:
            fam.setdefault("girl", set()).add(tag_id)
    con.close()

    sample = json.loads((OUT / "sample.json").read_text(encoding="utf-8"))
    report = json.loads((OUT / "report.json").read_text(encoding="utf-8"))

    ids = report["fullScores"]["photoIds"]
    scores_q = report["fullScores"]["quantized"]
    scores_u = report["fullScores"]["unquantized"]

    # 2) 一次性把这些照片的家族标签置信度全取出来
    con = sqlite3.connect(DB, uri=True)
    cur = con.cursor()
    all_ids = set()
    for fam_name in fam:
        all_ids.update(fam[fam_name])
    id_list = ",".join(str(i) for i in all_ids)

    per_photo = {pid: {} for pid in ids}
    qmarks = ",".join("?" * len(ids))
    rows = cur.execute(
        f"""select photo_id, tag_id, confidence from photo_tags
            where photo_id in ({qmarks}) and tag_id in ({id_list})""",
        ids,
    ).fetchall()
    con.close()

    fam_of_tag = {}
    for fam_name, tids in fam.items():
        for t in tids:
            fam_of_tag[t] = fam_name
    for photo_id, tag_id, confidence in rows:
        fam_name = fam_of_tag[tag_id]
        cur_best = per_photo[photo_id].get(fam_name, 0.0)
        if confidence and confidence > cur_best:
            per_photo[photo_id][fam_name] = float(confidence)

    def relevance(pid):
        t = per_photo.get(pid, {})
        return 0.55 * t.get("headphones", 0.0) + 0.30 * t.get("indoors", 0.0) + 0.15 * t.get("girl", 0.0)

    def has_headphones(pid):
        return per_photo.get(pid, {}).get("headphones", 0.0) >= HP_THRESHOLD

    def has_indoors(pid):
        return per_photo.get(pid, {}).get("indoors", 0.0) >= HP_THRESHOLD

    def rank_by(scores):
        return [ids[i] for i in sorted(range(len(ids)), key=lambda i: -scores[i])]

    order_q = rank_by(scores_q)
    order_u = rank_by(scores_u)

    def metrics(order, k):
        top = order[:k]
        return {
            "k": k,
            "耳机命中数": sum(1 for p in top if has_headphones(p)),
            "耳机命中率": round(sum(1 for p in top if has_headphones(p)) / k, 4),
            "室内命中数": sum(1 for p in top if has_indoors(p)),
            "平均相关度": round(sum(relevance(p) for p in top) / k, 4),
        }

    result = {
        "查询词": report["query"],
        "样本数": len(ids),
        "全样本基线": {
            "耳机命中数": sum(1 for p in ids if has_headphones(p)),
            "室内命中数": sum(1 for p in ids if has_indoors(p)),
            "平均相关度": round(sum(relevance(p) for p in ids) / len(ids), 4),
        },
        "int8量化版": {f"@{k}": metrics(order_q, k) for k in (5, 10, 15, 30)},
        "未量化fp32版": {f"@{k}": metrics(order_u, k) for k in (5, 10, 15, 30)},
    }

    # 3) 只看"独有"的那几张，量化差异到底体现在哪
    set_q15, set_u15 = set(order_q[:15]), set(order_u[:15])
    result["int8独有(不在fp32 Top15)"] = [
        {
            "id": p,
            "int8排名": order_q.index(p) + 1,
            "int8相似度": round(scores_q[ids.index(p)], 4),
            "fp32排名": order_u.index(p) + 1,
            "耳机": round(per_photo.get(p, {}).get("headphones", 0.0), 3),
            "室内": round(per_photo.get(p, {}).get("indoors", 0.0), 3),
            "少女": round(per_photo.get(p, {}).get("girl", 0.0), 3),
            "相关度": round(relevance(p), 4),
        }
        for p in sorted(set_q15 - set_u15, key=lambda p: order_q.index(p))
    ]
    result["fp32独有(不在int8 Top15)"] = [
        {
            "id": p,
            "fp32排名": order_u.index(p) + 1,
            "fp32相似度": round(scores_u[ids.index(p)], 4),
            "int8排名": order_q.index(p) + 1,
            "耳机": round(per_photo.get(p, {}).get("headphones", 0.0), 3),
            "室内": round(per_photo.get(p, {}).get("indoors", 0.0), 3),
            "少女": round(per_photo.get(p, {}).get("girl", 0.0), 3),
            "相关度": round(relevance(p), 4),
        }
        for p in sorted(set_u15 - set_q15, key=lambda p: order_u.index(p))
    ]

    # 4) 全 300 张里带耳机的图，两侧各自排到第几 —— 最能说明问题的数字
    hp_ids = [p for p in ids if has_headphones(p)]
    result["带耳机的图在两侧的排名"] = sorted(
        (
            {
                "id": p,
                "耳机置信度": round(per_photo[p]["headphones"], 3),
                "int8排名": order_q.index(p) + 1,
                "fp32排名": order_u.index(p) + 1,
            }
            for p in hp_ids
        ),
        key=lambda r: r["int8排名"],
    )

    (OUT / "tag-relevance.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
