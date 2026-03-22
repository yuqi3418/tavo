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

    // 【改动 1】只强制要求提供 NovelAI 的 Token
    if (!NAI_KEY) {
      return res.status(400).send("参数缺失：请提供 token (NovelAI Key)");
    }

    // 【改动 2】智能判断是否启用了 Git 存储功能
    const useGit = Boolean(GIT_TOKEN && GIT_REPO);

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

    const hashStr = req.query.tag || "empty_tag";
    const cacheHash = crypto.createHash('md5').update(hashStr).digest('hex');
    const fileName = `${cacheHash}.png`;
    const filePath = `images/${fileName}`; 

    let gitApiUrl, gitHeaders;
    
    // 如果启用了 Git，才初始化这些变量
    if (useGit) {
      gitApiUrl = `https://api.github.com/repos/${GIT_REPO}/contents/${filePath}`;
      gitHeaders = {
        'Authorization': `token ${GIT_TOKEN}`,
        'User-Agent': 'Tavo-Proxy'
      };
    }

    // 【改动 3】只有启用了 Git，才去检查有没有缓存
    if (!nocache && useGit) {
      const checkGitRes = await fetch(gitApiUrl, { headers: gitHeaders });
      if (checkGitRes.status === 200) {
        console.log(`命中缓存 (Tag: ${hashStr}): 准备通过 CDN 返回 ${fileName}`);
        const gitRawUrl = `https://cdn.jsdelivr.net/gh/${GIT_REPO}/main/${filePath}`;
        return res.redirect(302, gitRawUrl);
      }
    }

    // 如果没开 Git，或者开了没命中，就走正常画图流程
    const logMsg = useGit ? "未命中缓存" : "未启用 Git 缓存";
    console.log(`${logMsg}，开始画新图 (Tag: ${hashStr})`);

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

    const arrayBuffer = await naiRes.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const imageFiles = Object.values(zip.files).filter(f => f.name.endsWith('.png'));
    
    if (imageFiles.length === 0) throw new Error("解压失败，未找到图片");
    const imgBuffer = await imageFiles[0].async("nodebuffer");
    
    // 【改动 4】只有启用了 Git，才去执行上传操作
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
          message: `Auto-upload/Update: ${fileName}`,
          content: base64Img,
          sha: sha 
        })
      }).catch(err => console.error("Git 上传异常:", err.message));
    }

    // 无论开没开 Git，最后都要把图发给用户
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
