# Pulse · 加密交易复盘桌面客户端 (Trading Review System)

一款**离线优先（Offline-First）**、采用 **Apple 独立开发者科技极简美学** 的加密货币交易复盘桌面客户端。本地基于原生 `SQLite (WAL + mmap)` 实现亚毫秒级零延迟查询，联网直连交易所只读 API 与主流大模型进行高精度量化复盘。

## ✨ 核心架构特性

- **高精度加密合单状态机 (`decimal.js` 36 位精度)**
  - 原生支持 **U本位线性合约 (`usdm`)**、**币本位反向合约 (`coinm` 调和均价)** 与 **现货 (`spot`)**。
  - 完整覆盖真实交易边缘场景：单向持仓一笔反手原子拆单（Position Flip）、双向对冲持仓（Hedge Mode）隔离、`BNB` 抵扣手续费汇率折算、Maker 负费率返佣、持仓窗口资金费（Funding Fee）归集、强平清算费（Insurance Clear）识别。
- **零编译依赖本地高速存储 (`node:sqlite`)**
  - 默认启用 `WAL` 预写日志与 `256MB mmap` 内存映射。
  - 内置 **历史无 ID CSV 与增量 API 流水语义指纹幂等对齐（Zero Double-Counting）** 及 **断网/限流单事务 ACID 原子回滚**。
- **全主流大模型兼容规划**
  - 本地毫秒级预计算区间统计 JSON 画像 + 统一流式接入 OpenAI / Claude / Gemini / DeepSeek / 本地 Ollama。

## 📂 目录结构

```text
├── docs/
│   ├── DEVELOPMENT_PLAN.md          # 完整五阶段开发计划与架构说明
│   └── ui-preview-apple-minimal.html# 极简风三主题 (Obsidian/Alabaster/Titanium) 交互概念预览
├── src/
│   ├── shared/                      # 前后端共享领域类型与强类型 IPC 契约
│   ├── core/
│   │   ├── math/decimal.ts          # 高精度十进制运算与防尾差工具
│   │   ├── importer/dedup.ts        # 交易指纹与幂等去重键生成
│   │   ├── aggregator/              # 加密仓位合单核心状态机
│   │   ├── analytics/               # 16 项核心指标与六维优势分计算引擎
│   │   └── db/repository.ts         # SQLite (WAL) 存储与原子同步事务层
│   ├── main/                        # Electron 主进程与 IPC 处理器
│   ├── preload/                     # 安全隔离 contextBridge 预加载层
│   └── renderer/                    # React 19 极简桌面界面
├── tests/
│   └── edge-cases.test.ts           # E1–E8 八大边缘场景自动化回归测试套件
└── HANDOFF.md                       # 每次研发操作的强制状态交接记录
```

## 🚀 快速开始

> 环境要求：`Node.js >= 22.14`（推荐 `Node.js v24 LTS`）

```bash
# 1. 安装依赖
npm install

# 2. 运行类型检查与 E1–E8 边缘测试套件
npm run typecheck
npm test

# 3. 启动 Electron 桌面客户端开发环境
npm run dev

# 4. 生产构建验证
npm run build
```
