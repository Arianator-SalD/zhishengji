# 职升机 Careerfly · 工程协作入口

## 项目背景与当前边界
- 面向大学生职业探索、求职决策及专家咨询的产品 Demo，将有来源的专家经验转化为针对用户背景的建议和下一步行动。
- 原生 HTML/JavaScript + FastAPI，GitHub main 关联 Render 自动部署；站点：[职升机](https://zhishengji-voice.onrender.com)。
- Sally 接 DeepSeek 与火山引擎 ASR/TTS，其余专家保留 mock；公共组件修改需保持专家身份、资料和会话隔离。
- Sally 默认带入“金融转 AI 产品”模拟同学档案，可切换空白会话；对话仅使用本次连接历史。行动计划勾选保存在 localStorage，完整画像、记录和规划数据链路尚未打通。
- 用户最新要求优先于历史方案；prototype、旧截图、压缩包和方案不是当前源码的替代来源。

## 每次迭代必须更新日志
- [迭代日志.md](迭代日志.md) 是唯一日志正文；开工先读最新记录，结束前必须核对本次条目。
- 功能、修复、界面、文案、提示词、用户画像、配置及项目文档迭代都要记录；外层目录的相关变更也写入此日志，不能只改 AGENTS.md 或 README 而漏记。
- 使用北京时间、新记录在前，至少包含 **需求、改动、验证、交付**；未完成项明确写出，不编造日期、提交编号、模型结果或测试结果。
- 代码与日志一同提交；提交编号未知时写“随本次提交”。部署完成后回填同一条的提交编号和线上核对结果，仅提交或推送不能写“已上线”。
- 区分静态检查、模拟供应商测试、真实接口与浏览器实机验证；历史测试通过不代表本次重新验证。
- 不记录 Key、Token、访问口令或用户咨询原文。纯文档提交使用 [skip render]，避免无意义部署。
- 文件新增、移动、删除时同步维护下方索引；交付时附日志链接。外层日志入口如存在，必须指向本文件，不能维护两个副本。

## 文件索引
| 文件或目录 | 职责 |
| --- | --- |
| [README.md](README.md) | 对外产品介绍，不放内部配置和资料链接 |
| [迭代日志.md](迭代日志.md)、[AGENTS.md](AGENTS.md) | 迭代记录、工程协作约定与索引 |
| [RENDER部署.md](RENDER部署.md)、[render.yaml](render.yaml) | 部署说明与服务配置，现有环境变量在部署平台维护 |
| [VALIDATION.md](VALIDATION.md)、[新版HTML移植说明.md](新版HTML移植说明.md) | 历史验证说明、新版原型迁移对照 |
| [requirements.txt](requirements.txt)、[启动本地Demo.command](启动本地Demo.command) | Python 依赖、本地启动入口 |
| [static/index.html](static/index.html) | 当前页面、专家数据、原型交互与内联样式；含大段嵌入图片，读取时限制输出 |
| [static/consultation-ui.js](static/consultation-ui.js) | Sally 与公共专家页面的 UI 适配、已有信息面板 |
| [static/voice.js](static/voice.js)、[static/voice.css](static/voice.css) | 真实对话连接、录音/播放生命周期及补充样式 |
| [static/audio-worklet.js](static/audio-worklet.js) | 麦克风采样与 PCM 处理 |
| [static/demo-chat.js](static/demo-chat.js) | 其他专家 mock 回复、按专家隔离的聊天状态 |
| [static/action-plan.js](static/action-plan.js) | 行动勾选、进度与本地持久化 |
| [static/sally-profile.jpg](static/sally-profile.jpg)、[static/user-avatar.jpg](static/user-avatar.jpg)、[static/advisor.svg](static/advisor.svg) | 页面图片资产 |
| [content/persona.md](content/persona.md) | Sally 本人经历、观点和对话策略，进入 system prompt |
| [content/qa.json](content/qa.json)、[content/demo_user.json](content/demo_user.json) | 展示 QA 与模拟咨询者档案，不得混淆专家与咨询者身份 |
| [server/main.py](server/main.py)、[server/access.py](server/access.py) | FastAPI 路由、静态资源、访问控制 |
| [server/context.py](server/context.py)、[server/session.py](server/session.py) | 上下文拼装、会话历史、语音轮次与打断处理 |
| [server/providers.py](server/providers.py)、[server/settings.py](server/settings.py) | 模型/语音供应商协议与配置；server/__init__.py 是包入口 |
| [tests/](tests/) | 后端、访问控制、供应商协议、录音算法、档案及浏览器回归；browser_harness.py 只用于模拟供应商测试 |
| [prototype/](prototype/) | 用户提供的两个原始 HTML 留档，线上入口不是这些文件 |
| artifacts/、frontend-preview.png | 素材生成记录、辅助脚本、历史图片与预览；先确认归属，不自动删除或提交 |
| .env.example、.env、.gitignore | 配置示例、本地凭据和忽略规则；凭据不得进入 Git、前端、提示词或日志 |
| .git/、.venv/、.pytest_cache/、__pycache__/ | 版本历史、运行环境和测试缓存，不是业务内容 |

## 依赖与文件级检查
- shell 遵循 RTK 约定，以 rtk 开头。使用已有 .venv 和 pip，依赖由 requirements.txt 管理；前端没有 npm 构建流程。
- 按修改范围选择检查，不为低风险纯文案改动新增实现镜像测试。
- 后端：`rtk proxy .venv/bin/python -m pytest tests/test_backend.py -q`；供应商和访问控制分别选 tests/test_providers.py、tests/test_access.py。
- 前端：`rtk proxy node --check static/voice.js`；录音/档案：`rtk proxy node --test tests/audio-worklet.test.cjs tests/demo-memory.test.cjs`。
- 文档：`rtk proxy git diff --check -- AGENTS.md 迭代日志.md`；浏览器回归先读对应脚本与说明，模拟麦克风不代表实机录音已验证。

## 协作与提交
- 修改共享文件前检查 Git 状态，只暂存本次文件，保留他人未提交内容；未经任务要求不重写原稿、不调整模型 Key、不改变其他专家 mock。
- AI 创建提交应以真实代理名称添加 Co-Authored-By，例如 `Co-Authored-By: Codex <noreply@openai.com>`，不冒用其他模型身份。
