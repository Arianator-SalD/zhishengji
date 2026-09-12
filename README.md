# 职升机 · Sally语音咨询 Demo

项目改动与验证记录见 [迭代日志](迭代日志.md)。每次迭代请按文末模板追加记录。

保留原 HTML 的页面与咨询入口，接入 FastAPI。对话链路是：浏览器麦克风 → 火山流式语音识别 2.0 → DeepSeek 流式回答 → 火山语音合成 2.0 → 浏览器边收边播。无需数字人形象。

本次使用最新的 `职升机_Web交互Demo.html`。原文件完整保存在 `prototype/`，线上使用 `static/index.html` 的后端接入版本。其余专家、注册、社区和咨询记录为原型交互；当前实际咨询身份为Sally。

Render 操作见 [部署步骤](RENDER部署.md)。真实 Key 仅在 Render 的 Environment 页面输入。另需设置至少 12 位的 `DEMO_ACCESS_PASSWORD`，供团队成员进入演示使用；它不是模型 Key。Render 环境缺少访问口令时，除健康检查外默认不开放页面和对话。

## 启动

在本文件所在目录运行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
.venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port 8765
```

打开 http://127.0.0.1:8765 ，点击Sally卡片。不要直接双击 HTML，页面需要同源后端。

本机已有 `.venv` 时，可直接双击 `启动本地Demo.command`。它只监听本机地址。

## 你需要提供的配置

在项目 `.env` 中填入，保存后重启后端。不要把密钥放进 HTML 或聊天消息。

| 本地字段 | 从哪里获得 |
| --- | --- |
| `LLM_API_KEY` | [DeepSeek 开放平台](https://platform.deepseek.com/)创建 API Key；需要可用 API 余额 |
| `LLM_MODEL` | 默认 `deepseek-flash`，可以换成账户可调用的模型 ID |
| `VOLC_ASR_API_KEY` | [火山语音控制台](https://console.volcengine.com/speech/app)中对流式识别服务有权限的 API Key |
| `VOLC_TTS_API_KEY` | 对语音合成服务有权限的 API Key；若同一 Key 获得两项权限，可填相同值 |
| `VOLC_TTS_SPEAKER` | 控制台音色详情对应的 ID。示例为 `zh_female_vv_uranus_bigtts`，需确认该账户可用 |

截图中的 ASR 20 小时试用包和 TTS 2 万字试用包对应本方案的语音服务。它们不包含 DeepSeek 费用。资源实例名称不是 API Key，也不应替换配置里的资源类型 ID。旧版语音控制台也可分别填写 App ID + Access Token；新版 Key 优先。

页面显示“已配置”仅表示本地配置齐全；权限、额度、音色是否匹配，需要真实请求验证。未配置时会显示提示，不生成模拟实时回答。

## 演示方式

1. 从 Sally 专家页面的四个推荐问题开始，覆盖转行、技术深度、产品方案、经历主线；参考回答保存在 `content/qa.json`。
2. 配好 DeepSeek 后，用 AI Chat 测试四个问题和各自一条追问。此入口只输出文字，便于先验证内容。
3. 配好两项语音服务，打开“语音通话”，点“开始说话”。说完后点“说完了，发送”，短暂停顿不会自动提交。每轮最长 60 秒。
4. 回答按句合成并连续播放。点“停止回答”再继续提问。第一版采用明确开始/停止操作，尚未实现边播放边监听的自动插话。
5. 当前页面默认从零开始，不带模拟画像；聊天弹窗内点“新会话”会清空上下文。后端保留模拟画像数据供开发测试。

## 内容与记忆

- `content/persona.md`：本人经历、判断方式、口语表达规则；资料里的内容作为参考，不能覆盖系统指令。
- `content/qa.json`：四组问题、参考回答、追问与原文来源；Photo Coach 明确是产品构想。
- `content/demo_user.json`：模拟同学的已知背景、待验证偏好和未知信息，区别于咨询者本人经历。
- 每个 WebSocket 单独保留近期消息，最多 24 条；断线即清空，不持久化、不写日志。语音回答只把浏览器确认播完的句子计入后续上下文，打断时当前未播完句子不计入。

飞书精选内容已整理为本地文件，第一版不需要注册飞书应用，也不需要向量数据库。更新资料时改这三个文件并重启即可。

## 检查与部署

```sh
.venv/bin/python -m pytest tests -q
node --test tests/audio-worklet.test.cjs
```

自动化用注入的测试替身检验协议、流式处理、会话隔离与打断，不代表真实服务验收。真实验收需要实际说话，检查识别准确性、回答内容、播音衔接和两轮追问。

团队对外演示时，可将同一 FastAPI 进程部署到支持长期 WebSocket 的服务器，域名走 HTTPS（麦克风需要安全上下文，本机 localhost 例外），代理开启 WebSocket 升级并设置足够超时。Render 域名会自动加入允许主机，其他域名需设置 `ALLOWED_HOSTS`。已提供共享演示口令、每个 IP 每分钟最多 5 次登录尝试、单进程最多 3 个同时连接；口令有效期 12 小时，修改口令会使旧登录失效。已登录用户仍能消耗额度，服务商侧应设置费用提醒或预算。本版本适用于受邀团队演示，不是多租户商业服务。

接口：`GET /health`、`GET /api/config`、`WS /ws/voice`。ASR 上传 PCM16k 单声道；TTS 返回 PCM24k，由 AudioContext 顺序调度。

官方协议参考：[DeepSeek API](https://api-docs.deepseek.com/)、[火山流式识别](https://docs.volcengine.com/docs/6561/1354869?lang=zh)、[火山流式合成](https://docs.volcengine.com/docs/6561/1598757?lang=zh)。
