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

app.get(["/", "/generate"], async (req, res) => {
  try {
    if (Object.keys(req.query).length === 0) {
      return res.send("服务运行中，请通过 Tavo 传入参数调用。");
    }

    const NAI_KEY = req.query.token;
    const GIT_TOKEN = req.query.git_token;
    const GIT_REPO = req.query.git_repo;

    // 1. 基础校验
    if (!NAI_KEY) {
      return res.status(400).send("参数缺失：请提供 token (NovelAI Key)");
    }

    const useGit = Boolean(GIT_TOKEN && GIT_REPO);

    // 2. 接收绘图参数
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

    // 3. 尺寸计算
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

    // 4. 哈希与路径 (只认 tag 确保缓存命中)
    const hashStr = req.query.tag || "empty_tag";
    const cacheHash = crypto.createHash('md5').update(hashStr).digest('hex');
    const fileName = `${cacheHash}.png`;
    const filePath = `images/${fileName}`; 

    let gitApiUrl, gitHeaders;
    if (useGit) {
      gitApiUrl = `https://api.github.com/repos/${GIT_REPO}/contents/${filePath}`;
      gitHeaders = {
        'Authorization': `token ${GIT_TOKEN}`,
        'User-Agent': 'Tavo-Proxy'
      };
    }

    // 5. 【私密缓存检查】直接重定向到 GitHub 私有直连
    if (!nocache && useGit) {
      const checkGitRes = await fetch(gitApiUrl, { headers: gitHeaders });
      if (checkGitRes.status === 200) {
        const gitData = await checkGitRes.json();
        console.log(`[命中缓存] (Tag: ${hashStr}) -> 正在通过 GitHub 私有直连安全返回`);
        // 这里会跳转到带临时 token 的官方直连，既不走 CDN 也不耗你的服务器流量
        return res.redirect(302, gitData.download_url);
      }
    }

    // 6. 调用 NovelAI 生成新图
    console.log(`[新生成] (Tag: ${hashStr})`);
    const isV4 = model.includes("nai-diffusion-4");
    const aiParams = { width, height, steps, scale, sampler, negative_prompt, noise_schedule };

    if (isV4) {
      aiParams.v4_prompt = { caption: { base_caption: finalInput, char_captions: [] } };
      aiParams.v4_negative_prompt = { caption: { base_caption: negative_prompt, char_captions: [] } };
    }

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
        parameters: aiParams
      })
    });

    if (!naiRes.ok) {
      return res.status(naiRes.status).send(`NovelAI 报错: ${await naiRes.text()}`);
    }

    // 7. 解压图片
    const arrayBuffer = await naiRes.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const imageFiles = Object.values(zip.files).filter(f => f.name.endsWith('.png'));
    if (imageFiles.length === 0) throw new Error("解压失败");
    const imgBuffer = await imageFiles[0].async("nodebuffer");
    
    // 8. 异步存档到 Git
    if (useGit) {
      const base64Img = imgBuffer.toString('base64');
      let sha = undefined;
      if (nocache) {
          const checkExist = await fetch(gitApiUrl, { headers: gitHeaders });
          if (checkExist.status === 200) {
              sha = (await checkExist.json()).sha;
          }
      }

      fetch(gitApiUrl, {
        method: 'PUT',
        headers: { ...gitHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Auto-save: ${fileName}`,
          content: base64Img,
          sha: sha 
        })
      }).catch(err => console.error("Git Upload Error:", err.message));
    }

    // 9. 直接返回新图数据
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Content-Type", "image/png");
    return res.end(imgBuffer);

  } catch (error) {
    console.error("Critical Error:", error);
    res.status(500).send(`Server Error: ${error.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is live on port ${PORT}`));
