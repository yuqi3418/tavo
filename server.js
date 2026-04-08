import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import JSZip from "jszip";
import crypto from "crypto";

const app = express();

const MY_NAI_KEY = process.env.NAI_KEY; 
const MY_GIT_TOKEN = process.env.GIT_TOKEN;
const MY_GIT_REPO = process.env.GIT_REPO; 

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get(["/", "/generate"], async (req, res) => {
  try {
    if (Object.keys(req.query).length === 0) return res.send("节点运行中（支持429自动重试）");

    const NAI_KEY = req.query.token || MY_NAI_KEY;
    const GIT_TOKEN = req.query.git_token || MY_GIT_TOKEN;
    const GIT_REPO = req.query.git_repo || MY_GIT_REPO;
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

    let width = 1024; let height = 1024;
    const sizeParam = req.query.size;
    if (sizeParam === "竖图") { width = 832; height = 1216; } 
    else if (sizeParam === "横图") { width = 1216; height = 832; }
    width = Math.round(width / 64) * 64;
    height = Math.round(height / 64) * 64;

    const cacheHash = crypto.createHash('md5').update(tag || "empty").digest('hex');
    const fileName = `${cacheHash}.png`;
    const filePath = `images/${fileName}`; 

    let gitApiUrl = `https://api.github.com/repos/${GIT_REPO}/contents/${filePath}`;
    let gitHeaders = { 'Authorization': `token ${GIT_TOKEN}`, 'User-Agent': 'Tavo-Proxy' };

    if (req.query.nocache !== "1" && useGit) {
      const checkGitRes = await fetch(gitApiUrl, { headers: gitHeaders });
      if (checkGitRes.status === 200) {
        const gitData = await checkGitRes.json();
        return res.redirect(302, gitData.download_url);
      }
    }

    const aiParams = { width, height, steps, scale, sampler, negative_prompt, noise_schedule };
    if (model.includes("nai-diffusion-4")) {
      aiParams.v4_prompt = { caption: { base_caption: finalInput, char_captions: [] } };
      aiParams.v4_negative_prompt = { caption: { base_caption: negative_prompt, char_captions: [] } };
    }

    let naiRes;
    for (let i = 0; i < 5; i++) {
      naiRes = await fetch("https://image.novelai.net/ai/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${NAI_KEY}` },
        body: JSON.stringify({ input: finalInput, model: model, action: "generate", parameters: aiParams })
      });

      if (naiRes.status === 429) {
        console.log(`[429限流] 第 ${i+1} 次重试...`);
        await sleep(2000 + i * 1000);
        continue;
      }
      break; 
    }

    if (!naiRes.ok) return res.status(naiRes.status).send(await naiRes.text());

    const arrayBuffer = await naiRes.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const imgBuffer = await Object.values(zip.files).filter(f => f.name.endsWith('.png'))[0].async("nodebuffer");
    
    if (useGit) {
      fetch(gitApiUrl, {
        method: 'PUT',
        headers: { ...gitHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Save: ${fileName}`, content: imgBuffer.toString('base64') })
      }).catch(e => console.error("Git Error:", e.message));
    }

    res.setHeader("Content-Type", "image/png");
    return res.end(imgBuffer);

  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.listen(3000, () => console.log("服务已启动"));
