#!/usr/bin/env python3
"""
build_vocab_embeddings.py — precompute FashionCLIP text embeddings for the
fixed clothing vocabulary, so the shipped app never downloads a text encoder.

Why: the vocabulary in js/utils/clothingParser.js is fixed at build time, so
its embeddings are a build artifact, not something each user's browser should
recompute. Precomputing here removes a ~61 MB download and a slow in-browser
encode pass from every first run. The vision encoder still runs on-device;
only these constants are baked in.

Usage:
    python3 scripts/build_vocab_embeddings.py

Writes:
    models/fashion-vocab.bin    float32 [N x dim], L2-normalized, row-major
    models/fashion-vocab.json   manifest: model id, dim, vocabVersion, prompts

Requires: onnxruntime, tokenizers, numpy  (pip install --user onnxruntime tokenizers numpy)
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

import numpy as np
from tokenizers import Tokenizer
import onnxruntime as ort

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "models")
CACHE = os.path.join("/tmp", "om-fashionclip")

# Every model the app may load needs its own vocabulary file: text and image
# embeddings are only comparable within the same model's space.
MODELS = [
    {"id": "Marqo/marqo-fashionCLIP", "slug": "marqo-fashionclip"},
    {"id": "Xenova/clip-vit-base-patch32", "slug": "clip-vit-b32"},
]
TEXT_ONNX = "onnx/text_model.onnx"        # full precision for build-time quality
TOKENIZER = "tokenizer.json"
CONTEXT = 77                               # CLIP's fixed context length

BASE = ""                                  # set per model in main()


def fetch(rel):
    """Download a repo file into the local cache if not already there.

    Uses curl rather than urllib: this Python build has no CA bundle wired
    up, and curl already trusts the system keychain.
    """
    os.makedirs(CACHE, exist_ok=True)
    dest = os.path.join(CACHE, BASE.split("/")[-3] + "_" + rel.replace("/", "_"))
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print(f"  downloading {rel} …")
    subprocess.run(
        ["curl", "-sSL", "-o", dest, f"{BASE}/{rel}"],
        check=True,
    )
    return dest


def prompts_from_js():
    """
    Run the real clothingParser module under node so the prompt list and its
    version hash can never drift from what the app actually asks for.
    """
    script = (
        "import('file://%s/js/utils/clothingParser.js')"
        ".then(m => console.log(JSON.stringify("
        "{prompts: m.allPrompts(), version: m.vocabVersion()})))" % REPO
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def build(model, prompts, version):
    global BASE
    BASE = f"https://huggingface.co/{model['id']}/resolve/main"
    print(f"\n=== {model['id']} ===")
    print("Fetching model files …")
    tok = Tokenizer.from_file(fetch(TOKENIZER))
    sess = ort.InferenceSession(fetch(TEXT_ONNX), providers=["CPUExecutionProvider"])

    inputs = {i.name for i in sess.get_inputs()}
    print(f"  onnx inputs: {sorted(inputs)}")

    # CLIP pads with token id 0 ('!') up to the fixed context length.
    tok.enable_truncation(max_length=CONTEXT)
    tok.enable_padding(length=CONTEXT, pad_id=0, pad_token="!")

    encoded = tok.encode_batch(prompts)
    ids = np.array([e.ids for e in encoded], dtype=np.int64)
    mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
    print(f"  token tensor {ids.shape}")

    feed = {"input_ids": ids}
    if "attention_mask" in inputs:
        feed["attention_mask"] = mask

    print("Running the text encoder …")
    outputs = sess.run(None, feed)
    names = [o.name for o in sess.get_outputs()]
    # Prefer the projected embedding output; fall back to the first 2-D output.
    idx = next((i for i, n in enumerate(names) if "embed" in n.lower()), None)
    if idx is None:
        idx = next(i for i, o in enumerate(outputs) if o.ndim == 2)
    embeds = np.asarray(outputs[idx], dtype=np.float32)
    print(f"  output '{names[idx]}' {embeds.shape}")

    # L2-normalize so the browser only has to do a dot product.
    norms = np.linalg.norm(embeds, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    embeds = (embeds / norms).astype(np.float32)

    os.makedirs(OUT_DIR, exist_ok=True)
    slug = model["slug"]
    bin_path = os.path.join(OUT_DIR, f"fashion-vocab-{slug}.bin")
    embeds.tofile(bin_path)

    manifest = {
        "model": model["id"],
        "source": TEXT_ONNX,
        "dim": int(embeds.shape[1]),
        "count": int(embeds.shape[0]),
        "vocabVersion": version,
        "normalized": True,
        "dtype": "float32",
        "prompts": prompts,
    }
    with open(os.path.join(OUT_DIR, f"fashion-vocab-{slug}.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    kb = os.path.getsize(bin_path) / 1024
    print(f"  wrote models/fashion-vocab-{slug}.bin ({kb:.0f} KB) "
          f"— {embeds.shape[0]} x {embeds.shape[1]}")

    # Sanity: nearest prompts for a probe word should be semantically close.
    def probe(word):
        i = next((k for k, p in enumerate(prompts) if word in p), None)
        if i is None:
            return
        sims = embeds @ embeds[i]
        top = np.argsort(-sims)[1:4]
        print(f"    '{prompts[i]}' = " + "; ".join(f"{prompts[j]} ({sims[j]:.2f})" for j in top))

    print("  sanity check:")
    probe("hoodie")
    probe("jeans")
    return slug


def main():
    print("Reading vocabulary from js/utils/clothingParser.js ...")
    vocab = prompts_from_js()
    prompts, version = vocab["prompts"], vocab["version"]
    print(f"  {len(prompts)} prompts, version {version}")

    built = [build(m, prompts, version) for m in MODELS]
    print(f"\nDone: {len(built)} vocabulary files in models/")


if __name__ == "__main__":
    sys.exit(main())
