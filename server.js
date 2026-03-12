import express from "express";
import fetch from "node-fetch";
import JSZip from "jszip";
import crypto from "crypto";

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// 【修复 3】同时监听根目录和 /generate，防止路径错误
app.get(["/", "/generate"], async (req, res) => {
  try {
    // 防止浏览器空转直接访问报错
    if (Object.keys(req.query).length === 0) {
      return res.send("服务运行中，请通过 Tavo 传入参数调用。");
    }

    const NAI_KEY = req.query.token;
    const GIT_TOKEN = req.query.git_token;
    const GIT_REPO = req.query.git_repo;

    if (!NAI_KEY || !GIT_TOKEN || !GIT_REPO) {
      return res.status(400).send("参数缺失：请检查 token, git_token, git_repo");
    }

    const tag = req.query.tag || "1girl";
    const artist = req.query.artist || "";
    const finalInput = [tag, artist].filter(Boolean).join(", "); 
    
    const model = req.query.model || "nai-diffusion-3";
    const sampler = req.query.sampler || "k_euler";
    const steps = parseInt(req.query.steps) || 28;
    const scale = parseFloat(req.query.scale || req.query.cfg) || 5.0; 
    const negative_prompt = req.query.negative || "nsfw, lowres";
    const nocache = req.query.nocache === "1"; 

    let width = 1024; let height = 1024;
    const sizeParam = req.query.size;
    if (sizeParam === "竖图") {
      width = 832; height = 1216;
    } else if (sizeParam === "横图") {
      width = 1216; height = 832;
    } else if (sizeParam && sizeParam.includes('x')) {
      const sizeArr = sizeParam.split('x');
      width = parseInt(sizeArr[0]) || 1024;
      height = parseInt(sizeArr[1]) || 1024;
    }
    width = Math.round(width / 64) * 64;
    height = Math.round(height / 64) * 64;

    const hashStr = `${finalInput}_${model}_${width}x${height}_${steps}_${scale}_${sampler}_${negative_prompt}`;
    const cacheHash = crypto.createHash('md5').update(hashStr).digest('hex');
    const fileName = `${cacheHash}.png`;
    const filePath = `images/${fileName}`; 

    const gitApiUrl = `https://api.github.com/repos/${GIT_REPO}/contents/${filePath}`;
    const gitHeaders = {
      'Authorization': `token ${GIT_TOKEN}`,
      'User-Agent': 'Tavo-Proxy'
    };

    // 【修复 1】解决私有仓库 CDN 拦截问题，直接拿 GitHub 官方带鉴权的直链
    if (!nocache) {
      const checkGitRes = await fetch(gitApiUrl, { headers: gitHeaders });
      if (checkGitRes.status === 200) {
        console.log(`命中缓存: 返回 ${fileName}`);
        const gitData = await checkGitRes.json();
        if (gitData.download_url) {
          return res.redirect(302, gitData.download_url);
        }
      }
    }

    console.log(`未命中缓存，调用 NovelAI: ${fileName}`);

    const naiRes = await fetch("https://image.novelai.net/ai/generate-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${NAI_KEY}`
      },
      body: JSON.stringify({
        input: finalInput,
        model: model,
        action: "generate",
        parameters: { width, height, steps, scale, sampler, negative_prompt }
      })
    });

    if (!naiRes.ok) {
      return res.status(naiRes.status).send(`NovelAI 报错: ${await naiRes.text()}`);
    }

    const arrayBuffer = await naiRes.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const imageFiles = Object.values(zip.files).filter(f => f.name.endsWith('.png'));
    
    if (imageFiles.length === 0) throw new Error("解压失败，未找到图片");
    const imgBuffer = await imageFiles[0].async("nodebuffer");

    const base64Img = imgBuffer.toString('base64');
    
    // 取消了固定上传 main 分支的限制，兼容叫 master 分支的旧仓库
    fetch(gitApiUrl, {
      method: 'PUT',
      headers: { ...gitHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Auto-upload: ${fileName}`,
        content: base64Img
      })
    }).catch(err => console.error("Git 上传异常:", err.message));

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Content-Type", "image/png");
    return res.end(imgBuffer);

  } catch (error) {
    console.error("服务崩溃:", error);
    res.status(500).send(`服务端错误: ${error.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
