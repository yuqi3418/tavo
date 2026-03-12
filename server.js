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

app.get("/", (req, res) => {
  res.send("Tavo 直连专属代理已启动，等待请求...");
});

app.get("/generate", async (req, res) => {
  try {
    // 1. 核心提权：从 URL 直接抓取所有密钥（你要求的全明文模式）
    const NAI_KEY = req.query.token;
    const GIT_TOKEN = req.query.git_token;
    const GIT_REPO = req.query.git_repo;

    if (!NAI_KEY || !GIT_TOKEN || !GIT_REPO) {
      return res.status(400).send("参数缺失：URL 中必须包含 token, git_token, git_repo");
    }

    // 2. 抓取并组装画图参数
    const tag = req.query.tag || "1girl";
    const artist = req.query.artist || "";
    // 将提示词和画师风格组装在一起
    const finalInput = [tag, artist].filter(Boolean).join(", "); 
    
    const model = req.query.model || "nai-diffusion-3";
    const sampler = req.query.sampler || "k_euler";
    const steps = parseInt(req.query.steps) || 28;
    // URL 里有 scale 也有 cfg，优先取 scale，否则取 cfg
    const scale = parseFloat(req.query.scale || req.query.cfg) || 5.0; 
    const negative_prompt = req.query.negative || "nsfw, lowres, bad anatomy";
    const nocache = req.query.nocache === "1"; // 0为使用缓存，1为强行重新生成

    // 3. 尺寸处理
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
    // 强制对齐 64 的倍数防报错
    width = Math.round(width / 64) * 64;
    height = Math.round(height / 64) * 64;

    // 4. 生成缓存指纹 (不包含密钥和 nocache 标记，只要画图参数一样就是同一张图)
    const hashStr = `${finalInput}_${model}_${width}x${height}_${steps}_${scale}_${sampler}_${negative_prompt}`;
    const cacheHash = crypto.createHash('md5').update(hashStr).digest('hex');
    const fileName = `${cacheHash}.png`;
    const filePath = `images/${fileName}`; 

    const gitApiUrl = `https://api.github.com/repos/${GIT_REPO}/contents/${filePath}`;
    const gitHeaders = {
      'Authorization': `token ${GIT_TOKEN}`,
      'User-Agent': 'Tavo-Proxy'
    };

    // 5. 检查 GitHub 缓存 (如果没开 nocache)
    if (!nocache) {
      const checkGitRes = await fetch(gitApiUrl, { headers: gitHeaders });
      if (checkGitRes.status === 200) {
        console.log(`命中缓存: 返回 ${fileName}`);
        // 使用 jsDelivr 加速 GitHub 原始图片
        const cdnUrl = `https://cdn.jsdelivr.net/gh/${GIT_REPO}@main/${filePath}`;
        return res.redirect(302, cdnUrl);
      }
    }

    console.log(`开始调用 NovelAI 生成新图: ${fileName}`);

    // 6. 调用 NovelAI 官方接口
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
      const errText = await naiRes.text();
      return res.status(naiRes.status).send(`NovelAI API 报错: ${errText}`);
    }

    // 7. 解压二进制 ZIP 包拿图片
    const arrayBuffer = await naiRes.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const imageFiles = Object.values(zip.files).filter(f => f.name.endsWith('.png'));
    
    if (imageFiles.length === 0) throw new Error("ZIP 压缩包中未找到图片");
    const imgBuffer = await imageFiles[0].async("nodebuffer");

    // 8. 异步上传到 GitHub 仓库 (不让 Tavo 傻等)
    const base64Img = imgBuffer.toString('base64');
    fetch(gitApiUrl, {
      method: 'PUT',
      headers: { ...gitHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Auto-upload from Tavo: ${fileName}`,
        content: base64Img,
        branch: "main"
      })
    }).then(async (res) => {
      if (!res.ok) console.error("Git 上传失败:", await res.text());
      else console.log(`Git 上传成功: ${fileName}`);
    }).catch(err => console.error("Git 请求异常:", err.message));

    // 9. 将新生成的图片发回给 Tavo 界面
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Content-Type", "image/png");
    return res.end(imgBuffer);

  } catch (error) {
    console.error("服务崩溃:", error);
    res.status(500).send(`服务器端发生错误: ${error.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
