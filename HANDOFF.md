# HANDOFF.md · 项目研发交接与状态追踪日志

> **维护规则**：每次规划变更、架构调整、代码实现或测试验证后，必须第一时间更新本文件，确保上下文随时可恢复、可交接。

---

## 1. 当前总体状态（Current Project Status）

- **当前阶段**：`Phase 1 已完成 ✅`（桌面客户端底座、SQLite 存储层、高精度合单与指标内核、E1–E8 全部边缘测试通过并同步至 GitHub）
- **最后更新时间**：`2026-11-11 20:34 (+08:00)`
- **远程仓库**：`https://github.com/ChuAkara/Trading_Review_System` (`main` 分支)
- **已锁定技术底座**：
  - **桌面框架**：`Electron 35` + `electron-vite` + `React 19` + `TypeScript 5.8`
  - **本地数据库**：Node 原生 `node:sqlite` (`DatabaseSync`，开启 `WAL` + `256MB mmap`，零 `node-gyp` 编译依赖)
  - **高精度数学**：`decimal.js`（36 位十进制精度，彻底杜绝浮点尾差）
  - **测试引擎**：`Vitest`

---

## 2. 本次操作完成内容（Latest Step #03 Summary）

1. **Git 仓库对齐与隐私保护配置**：
   - 关联远程 `https://github.com/ChuAkara/Trading_Review_System.git` (`main`)；
   - 配置 `.gitignore` 严格忽略本地含个人信息的参考网页快照（`tsingxbt*`）、构建产物（`out/`、`node_modules/`）及本地 `.db` 数据库文件。
2. **完成 Phase 1 核心架构与桌面端全链路闭环**：
   - `src/core/math/decimal.ts`：封装 36 位高精度十进制运算与 `snapDustToZero` 尾差归零函数。
   - `src/core/aggregator/positionAggregator.ts`：实现支持 `usdm`（U本位线性）、`coinm`（币本位调和均价反向合约）、`spot`（现货）的合单状态机，完整处理单向反手拆单、双向对冲隔离、BNB 异构手续费汇率折算、Maker 负手续费返佣、资金费窗口分摊与强平清算费标记。
   - `src/core/importer/dedup.ts` & `src/core/db/repository.ts`：实现基于 `node:sqlite` (`WAL + mmap`) 的持久化仓库，支持历史无 ID CSV 与后续带 ID API 流水的语义指纹原位合并去重，以及同步中断时的单事务 `ROLLBACK` 回滚保护。
   - `src/core/analytics/metricsEngine.ts`：实现净盈亏、胜率、日胜率、盈利因子、盈亏比、最大回撤（绝对值与相对起始本金百分比）、恢复系数、连胜连亏、单笔期望值及 **六维优势分（0–100）** 计算引擎。
   - `src/main/`、`src/preload/`、`src/renderer/`：搭建极简风 Electron 无边框桌面窗口，打通 IPC 实时展示 SQLite 毫秒级延迟、示例账单一键灌入验证、深浅色切换与 `Ctrl+P` 隐私模糊模式。
3. **整理文档体系**：
   - 归档完整开发计划至 `docs/DEVELOPMENT_PLAN.md`，归档极简交互视觉概念页至 `docs/ui-preview-apple-minimal.html`，编写项目 `README.md`。

### 历史步骤归档
- **Step #02 (`2026-11-11 19:49`)**：探测本机 `Node.js v24.15.0 + Git 2.46.0` 环境，评估四大桌面底座并确立 `Electron + React + TypeScript + SQLite` 路线。
- **Step #01 (`2026-11-11 19:35`)**：收敛产品范围为单机离线优先加密复盘客户端，梳理 E1–E8 边缘测试矩阵，制作 Apple 极简风三主题交互预览页。

---

## 3. 核心边缘测试与构建验证结果（Edge-Case & Build Verification）

执行验证命令：`npm run typecheck && npm test && npm run build` —— **全部 0 错误通过（9/9 测试耗时 11ms）**：

- [x] **E1 异构资产手续费折算与拦截校验**：通过（验证 BNB 按成交汇率折算 USDT、Maker 负费率返佣增厚净利，缺失汇率时显式抛错拦截）。
- [x] **E2 单向持仓一笔反手（Position Flip）**：通过（验证持多 `1 BTC` 卖出 `2.5 BTC` 原子拆分为 `1 BTC` 平多闭合单 + `1.5 BTC` 新开空单，手续费按 40%/60% 精确守恒）。
- [x] **E3 十进制精度防尾差（Zero Dust）**：通过（验证 `0.1 + 0.2 - 0.3` 精确归零闭合，无 `1e-17` 幽灵未平仓残留）。
- [x] **E4 单向（`BOTH`）与双向对冲（`LONG`/`SHORT`）混用隔离**：通过（验证同标的切换模式及多空同时持仓互不串仓）。
- [x] **E5 资金费（`FUNDING_FEE`）时间窗口匹配**：通过（验证窗口内多笔结算归集与窗口外资金费严格排除）。
- [x] **E6 强平（Liquidation）与保险清算费（`INSURANCE_CLEAR`）**：通过（验证清算费并入净亏损并自动打上 `⚡ 强平` 系统标签）。
- [x] **E7 历史 CSV 与近期 API 幂等去重拼接**：通过（验证重复导 CSV 0 新增、API 补拉带 ID 流水自动原位升级旧 CSV 记录且净盈亏零翻倍）。
- [x] **E8 同步中断/429 限流 ACID 原子回滚**：通过（验证模拟中途抛 `HTTP 429` 异常时，`executions`、`trades` 零脏数据残留，`last_synced_at_ms` 水位线保持原值）。
- [x] **附加验证：COIN-M 币本位反向合约**：通过（验证调和加权开仓均价与 BTC 本位盈亏公式）。

---

## 4. 已知备忘与注意事项（Known Caveats）

1. Node v24 内置的 `node:sqlite` 运行时会输出一条实验特性提示（ExperimentalWarning），功能与底层 C++ SQLite 完全稳定，不影响事务安全性。
2. 本地目录中的 `tsingxbt · 交易复盘台.html` 及 `_files` 已被 `.gitignore` 安全排除在 Git 提交之外，仅保留在用户本地磁盘供随时对照参考。

---

## 5. 下一步行动指令（Next Actionable Steps · Phase 2 / Step #04）

进入 **Phase 2：Binance 全品类只读同步器 + 官方 CSV 解析器 + 网络代理与硬件加密密钥层**：
1. 基于 Electron `safeStorage` 实现本地 API Key / Secret 的系统级加密存储服务，并实现 Binance `/sapi/v1/account/apiRestrictions` **只读权限强制校验拦截**（若开启了交易或提币权限拒绝保存并告警）。
2. 实现支持 **本地 HTTP/SOCKS5 代理配置 + 延迟 Ping 测速** 的网络客户端层。
3. 实现 **Binance U本位 / 币本位 / 现货 并发 7 天分片增量同步器**（含本地权重令牌桶防 `429`、BNB 抵扣手续费分钟 K 线自动取价折算）与 **Binance 官方导出 CSV 账单解析器**，并补充 Mock HTTP 边界单测后更新 `HANDOFF.md`。
