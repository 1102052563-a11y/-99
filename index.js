import { extension_settings, getContext, renderExtensionTemplate } from "../../../extensions.js";
import { generateText } from "../../../script.js"; // 使用 ST 内部生成函数，或自定义 fetch

const EXTENSION_NAME = "canon-lock";
const CONFIG_FILE = "config.json";

// 默认设置
const defaultSettings = {
    searchApiKey: "", // Serper.dev Key
    searchProvider: "serper", // serper or google
    analysisModel: "gpt-4o-mini", // 模型名
    apiUrl: "https://api.openai.com/v1", // 独立API地址
    apiKey: "", // 独立API Key
    prompts: [] // 加载 config.json
};

let settings = defaultSettings;
let promptConfig = [];

// 加载配置
async function loadSettings() {
    settings = Object.assign({}, defaultSettings, extension_settings[EXTENSION_NAME]);
    
    // 读取本地的 config.json (Prompts)
    try {
        const response = await fetch(`/scripts/extensions/${EXTENSION_NAME}/${CONFIG_FILE}`);
        promptConfig = await response.json();
    } catch (e) {
        console.error("无法加载 Canon Lock 的 Prompt 配置", e);
    }
}

// ------------------------------------------
// 核心功能函数
// ------------------------------------------

// 1. 获取独立 API 的生成结果
async function callIndependentLLM(prompt) {
    // 这里演示使用 fetch 直接调用 OpenAI 格式接口
    // 如果想复用 ST 的主连接，可以使用 generateQuietly
    
    if (!settings.apiKey) {
        toastr.error("请先在插件设置中配置独立 API Key");
        return null;
    }

    const body = {
        model: settings.analysisModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3
    };

    try {
        const response = await fetch(`${settings.apiUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        return data.choices[0].message.content;
    } catch (e) {
        toastr.error("API 调用失败: " + e.message);
        return null;
    }
}

// 2. 执行 Google 搜索 (这里以 Serper.dev 为例，因为它返回纯净 JSON)
async function performGoogleSearch(query) {
    if (!settings.searchApiKey) {
        toastr.error("请配置搜索 API Key (Serper.dev)");
        return "";
    }

    // 强制附加排除词
    const safeQuery = `${query} -轮回乐园 -无限流 -穿越 -同人 -综漫 -主神空间 -系统 -聊天群 -副本 -飞卢`;
    
    console.log("[Canon Lock] Searching:", safeQuery);

    try {
        const response = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
                "X-API-KEY": settings.searchApiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ q: safeQuery, gl: "cn", hl: "zh-cn" })
        });
        
        const data = await response.json();
        
        // 整理搜索结果文本
        let resultText = "【搜索结果 - 原著优先】\n";
        if (data.organic) {
            data.organic.slice(0, 5).forEach((item, index) => {
                resultText += `${index + 1}. 标题: ${item.title}\n   摘要: ${item.snippet}\n\n`;
            });
        }
        return resultText;
    } catch (e) {
        console.error(e);
        return "搜索失败，请检查网络或Key。";
    }
}

// 3. 主流程：分析 -> 搜索 -> 生成
async function runCanonAnalysis() {
    const context =  SillyTavern.getContext();
    const chatHistory = context.chat.slice(-10).map(m => `${m.name}: ${m.message}`).join("\n");
    
    $("#canon-lock-results").html('<div class="canon-loading">正在锁定原著时间线...<br>1. 分析当前IP与节点</div>');

    // Step 1: 提取搜索词
    const queryPrompt = `
    阅读以下对话，提取当前所在的作品IP名称（如《海贼王》）以及当前剧情所处的大致时间点/章节。
    只输出搜索关键词，不要其他废话。
    格式：作品名 + 关键事件/章节
    
    对话内容：
    ${chatHistory}
    `;
    
    const searchQuery = await callIndependentLLM(queryPrompt);
    if (!searchQuery) return;

    $("#canon-lock-results").html(`<div class="canon-loading">正在锁定原著时间线...<br>2. 正在搜索: ${searchQuery}</div>`);

    // Step 2: 联网搜索
    const searchResults = await performGoogleSearch(searchQuery);

    // Step 3: 循环执行 Config 中的任务
    let finalHtml = "";
    
    // 为了节省 Token，我们可以把所有任务打包成一次请求，或者分批请求。
    // 鉴于你的需求比较复杂，我们针对每个 "panel: true" 的项生成内容。
    
    // 这里我们先生成最重要的 global_prompt 也就是上下文规则
    // 但在插件UI模式下，我们直接展示结果
    
    const uiItems = promptConfig.filter(item => item.panel === true);
    
    $("#canon-lock-results").html(`<div class="canon-loading">正在锁定原著时间线...<br>3. 正在对照原著生成分析报告...</div>`);

    for (const item of uiItems) {
        // 构建最终 Prompt
        const finalPrompt = `
        ${item.prompt}
        
        【必须参考的真实原著资料】
        ${searchResults}
        
        【当前对话上下文】
        ${chatHistory}
        
        请严格按照 JSON 或 列表格式输出结果。
        `;

        const content = await callIndependentLLM(finalPrompt);
        
        // 渲染 HTML
        finalHtml += `
            <div class="canon-card">
                <div class="canon-card-title">${item.title}</div>
                <div class="canon-card-content">${formatResult(content, item.type)}</div>
            </div>
        `;
        
        // 实时更新 UI (每生成一个显示一个)
        $("#canon-lock-results").html(finalHtml);
    }
}

// 简单的格式化工具
function formatResult(text, type) {
    if (!text) return "无内容";
    // 简单的 Markdown 转 HTML 处理
    return text.replace(/\n/g, "<br>").replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
}


// ------------------------------------------
// UI 构建
// ------------------------------------------

function createUi() {
    // 添加一个按钮到左侧或顶部扩展栏
    const btn = document.createElement("div");
    btn.className = "list-group-item flex-container flex-gap-10";
    btn.innerHTML = `<div class="fa-solid fa-book-journal-whills"></div><div>原著锁 (Canon Lock)</div>`;
    btn.onclick = () => {
        $("#canon-lock-panel").toggleClass("hidden");
    };
    
    // 这里简单地挂载到扩展菜单里，实际建议参考 ST 的 createDrawer 或类似 API
    // 为了演示方便，我们直接操作 DOM
    // 实际最好使用 extension_settings 的 UI 注入点
}

// 创建浮动面板或注入到右侧栏
function createPanel() {
    const panel = document.createElement("div");
    panel.id = "canon-lock-panel";
    panel.className = "hidden";
    panel.innerHTML = `
        <div class="canon-header">
            <h3>🛡️ 原著纯净模式</h3>
            <button id="canon-run-btn" class="menu_button">开始分析</button>
            <button id="canon-close-btn" class="menu_button">X</button>
        </div>
        <div id="canon-lock-results" class="canon-body">
            <div class="placeholder-text">点击“开始分析”以检索原著正史数据...</div>
        </div>
    `;
    document.body.appendChild(panel);

    document.getElementById("canon-run-btn").addEventListener("click", runCanonAnalysis);
    document.getElementById("canon-close-btn").addEventListener("click", () => {
        panel.classList.add("hidden");
    });
}

// ------------------------------------------
// 初始化
// ------------------------------------------
jQuery(async () => {
    await loadSettings();
    createPanel();
    
    // 添加设置菜单的 UI (这里省略详细的 Setting HTML 构建代码，通常使用 extension_settings.html)
    // 你需要在 ST 的 Extensions -> Canon Lock 中填入 API Key
    
    // 注入启动按钮到 ST 界面 (例如顶部栏)
    const topBar = document.querySelector("#extensions_menu");
    if(topBar) {
        // 这里的逻辑需要根据 ST 具体的 DOM 结构调整
    }
    
    // 临时方案：在 Slash Commands 添加命令 /canon
    SillyTavern.registerSlashCommand("canon", (args, value) => {
        $("#canon-lock-panel").toggleClass("hidden");
        if (!$("#canon-lock-panel").hasClass("hidden")) {
            runCanonAnalysis();
        }
    }, [], "打开原著分析面板", true, true);
});