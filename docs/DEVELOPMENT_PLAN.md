# Pulse · 加密交易复盘桌面客户端开发计划（Electron 离线优先最终定稿版）

## 1. 产品定位与核心原则
- **专注赛道**：加密货币专精复盘工作台（首版深度适配 **Binance 现货 / U本位永续 / 币本位反向合约**，预留 OKX / Bybit / Hyperliquid 适配器接口）。
- **运行形态**：**单机离线优先桌面客户端（Offline-First Desktop App）**。所有交易明细、合单快照、复盘笔记、历史 K 线缓存均存于本地单文件 SQLite，断网 100% 可用；联网时本机直连交易所只读 API 与全主流大模型 API（省去云端中转双倍 RTT 延迟，且彻底规避多用户共享 IP 封禁风险）。
- **视觉美学**：对标 *Fey / Copilot Money / Linear / Raycast* 的 **Apple 独立开发者科技极简风**（无边框窗口、圆角 Bento 层叠材质、去冗余网格线、全站 `tabular-nums` 等宽数字、`Ctrl/Cmd+P` 高斯模糊隐私脱敏）。交互概念预览见 [`docs/ui-preview-apple-minimal.html`](./ui-preview-apple-minimal.html)。
- **工程铁律**：**功能与边缘测试准确性 > 本地与网络速率优化 > UI 动效精修**；每次操作同步更新根目录 [`HANDOFF.md`](../HANDOFF.md)。

---

## 2. 技术栈底座（已锁定）

| 层级 | 选型方案 | 选型依据 |
| :--- | :--- | :--- |
| **桌面壳层与构建** | **Electron 35 + `electron-vite` + TypeScript 5.8** | 自带最新 Chromium 与 Node 内核，渲染 100% 一致，0.1s 极速热更新，免 C++ 编译链折腾 |
| **本地存储内核** | **Node 原生 `node:sqlite` (`DatabaseSync`)** | C++ 原生同步绑定，零 `node-gyp` ABI 兼容隐患；开启 `WAL + 256MB mmap`，本地聚合延迟 `< 2ms` |
| **金融高精度计算** | **`decimal.js`（36 位十进制有效精度）** | 全链路严禁 IEEE-754 浮点数运算，消除 `0.1 + 0.2` 精度漂移与 `1e-16` 幽灵未平仓尾差 |
| **前端交互与图表** | **React 19 + Recharts / ECharts + Lightweight Charts** | 后续按阶段接入 16 张可定制看板卡片、热力日历与本地缓存 K 线买卖点回放 |
| **密钥硬件安全** | **Electron `safeStorage`（Windows DPAPI / macOS Keychain）** | 系统级硬件加密保存交易所只读 API Key 与大模型密钥 |
| **测试框架** | **Vitest** | 毫秒级执行 E1–E8 核心合单与数据库原子回滚测试套件 |

---

## 3. 核心边缘测试矩阵（E1–E8 自动化验收标准）

已在 [`tests/edge-cases.test.ts`](../tests/edge-cases.test.ts) 全部落地自动化回归测试：
1. **E1 异构币种手续费折算**：识别 `BNB` 抵扣 U本位手续费（按成交时刻汇率折算为 `USDT`）及负手续费 Maker 返佣。
2. **E2 单向持仓一笔反手（Position Flip）**：反向成交量超过当前持仓量时，原子拆分为「平旧仓闭合 + 开反向新仓」并按比例守恒拆分手续费。
3. **E3 高精度防尾差（Zero Dust）**：分批建仓/平仓消除浮点误差，低于 `stepSize` 容差自动归零闭合。
4. **E4 单向持仓（`BOTH`）与双向对冲（`LONG`/`SHORT`）隔离**：同一交易对历史混用不同持仓模式或同时持有多空对冲单时互不串仓。
5. **E5 资金费（`FUNDING_FEE`）精确窗口归集**：按持仓毫秒窗口（含结算秒级容差）自动归集资金费，多仓并存时按名义价值比例分摊。
6. **E6 强平（Liquidation）与保险清算费（`INSURANCE_CLEAR`）**：计入强平额外清算费并自动打上 `⚡ 强平` 系统标签。
7. **E7 历史 CSV 导入与 API 同步幂等去重拼接**：支持无 `Trade ID` 的历史归档 CSV 与后续带 `Trade ID` 的 API 增量流水通过语义指纹自动原位升级合并，零重复计入。
8. **E8 同步异常 ACID 原子事务回滚**：中途断网或遇 `429` 限流中断时，单事务 `ROLLBACK` 确保无残缺脏仓位且同步水位线保持不变。

---

## 4. 五阶段研发路线图

- [x] **Phase 1：桌面底座、SQLite 存储层、高精度合单与指标内核、E1–E8 边缘测试集**（已完成）
- [ ] **Phase 2：Binance 只读 API 并发分片同步器 + 官方 CSV 解析器 + 本地代理/延迟测速 + `safeStorage` 密钥管理**
- [ ] **Phase 3：完整 16 指标自定义看板 + 带周合计的盈亏热力日历 + 每日复盘日记 + 多维筛选栏**
- [ ] **Phase 4：单笔交易本地缓存 K 线买卖点回放（自动计算 MAE/MFE 与 R 倍数）+ 策略库 + 深度交叉报告 + 研究笔记**
- [ ] **Phase 5：全主流大模型（OpenAI / Claude / Gemini / DeepSeek / Ollama）流式诊断台 + 本地备份导出 + UI 微交互打磨**
