import express from "express";
import fetch from "node-fetch";
import JSZip from "jszip";
import crypto from "crypto";

const app = express();

app.set('trust proxy', true);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.get(["/", "/generate"], async (req, res) => {
  try {
    if (Object.keys(req.query).length === 0) {
      return res.send("服务运行中");
    }

    // ✅ 优先环境变量（但仍兼容原参数）
    const NAI_KEY = process.env.NAI_KEY || req.query.token;
    const GIT_TOKEN = process.env.GIT_TOKEN || req.query.git_token;
    const GIT_REPO = process.env.GIT_REPO || req.query.git_repo;

    if (!NAI_KEY) {
      return res.status(400).send("缺少 token");
    }

    const useGit = Boolean(GIT_TOKEN && GIT_REPO);

    // ================= 参数（完全保持你原来的） =================
    const tag = req.query.tag || "";
    const artist = req.query.artist || "";
    const finalInput = [tag, artist].filter(Boolean).join(", ");

    const model = req.query.model || "nai-diffusion-4-5-full";
    const sampler = req.query.sampler || "k_euler_ancestral";
    const steps = parseInt(req.query.steps) || 28;
    const scale = parseFloat(req.query.scale || req.query.cfg) || 5;
    const negative_prompt = req.query.negative || "";
    const noise_schedule = req.query.noise_schedule || "karras";

    const nocache = req.query.nocache === "1";

    // ================= 尺寸 =================
    let width = 1024, height = 1024;
    const sizeParam = req.query.size;

    if (sizeParam === "竖图") {
      width = 832; height = 1216;
    } else if (sizeParam === "横图") {
      width = 1216; height = 832;
    } else if (sizeParam && sizeParam.includes("x")) {
      const [w, h] = sizeParam.split("x");
      width = parseInt(w) || 1024;
      height = parseInt(h) || 1024;
    }

    width = Math.round(width / 64) * 64;
    height = Math.round(height / 64) * 64;

    // ================= ✅ 改进缓存（但对用户无感） =================
    const hashStr = JSON.stringify({
      tag, artist, model, steps, scale, sampler, noise_schedule, width, height
    });

    const cacheHash = crypto.createHash("md5").update(hashStr).digest("hex");
    const fileName = `${cacheHash}.png`;
    const filePath = `images/${fileName}`;

    let gitApiUrl, gitHeaders;

    if (useGit) {
      gitApiUrl = `https://api.github.com/repos/${GIT_REPO}/contents/${filePath}`;
      gitHeaders = {
        Authorization: `token ${GIT_TOKEN}`,
        "User-Agent": "NAI-Proxy"
      };
    }

    // ================= ✅ CDN缓存读取 =================
    if (!nocache && useGit) {
      const cdnUrl = `https://cdn.jsdelivr.net/gh/${GIT_REPO}/${filePath}`;

      try {
        const imgRes = await fetch(cdnUrl);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());

          res.setHeader("Cache-Control", "public, max-age=31536000");
          res.setHeader("Content-Type", "image/png");
          return res.end(buffer);
        }
      } catch {}
    }

    console.log("生成:", finalInput);

    // ================= AI参数 =================
    const isV4 = model.includes("nai-diffusion-4");

    const aiParams = {
      width,
      height,
      steps,
      scale,
      sampler,
      noise_schedule,
      negative_prompt
    };

    if (isV4) {
      aiParams.v4_prompt = {
        caption: { base_caption: finalInput, char_captions: [] }
      };
      aiParams.v4_negative_prompt = {
        caption: { base_caption: negative_prompt, char_captions: [] }
      };
    }

    const naiRes = await fetch("https://image.novelai.net/ai/generate-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NAI_KEY}`
      },
      body: JSON.stringify({
        input: finalInput,
        model,
        action: "generate",
        parameters: aiParams
      })
    });

    if (!naiRes.ok) {
      return res.status(naiRes.status).send(await naiRes.text());
    }

    // ================= 解压 =================
    const zip = await JSZip.loadAsync(await naiRes.arrayBuffer());
    const imageFiles = Object.values(zip.files).filter(f => f.name.endsWith(".png"));

    if (imageFiles.length === 0) throw new Error("无图片");

    const imgBuffer = await imageFiles[0].async("nodebuffer");

    // ================= 上传缓存 =================
    if (useGit) {
      const base64 = imgBuffer.toString("base64");

      fetch(gitApiUrl, {
        method: "PUT",
        headers: { ...gitHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `cache: ${fileName}`,
          content: base64
        })
      }).catch(() => {});
    }

    res.setHeader("Content-Type", "image/png");
    return res.end(imgBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

app.listen(process.env.PORT || 3000);
