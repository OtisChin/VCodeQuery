# ChatGPT 验证码查询

一个用于查询 ChatGPT 登录验证码的网页工具。

用户输入邮箱地址后，系统会到你自有的邮箱中转站中查找对应邮箱账号，读取最新邮件，并尝试提取其中的验证码。项目同时提供本地 Node 运行方式和 Cloudflare Workers 部署方式。

## 功能特性

- 输入邮箱地址后查询最新验证码
- 自动从最新邮件内容中提取 4 到 8 位验证码
- 简洁的单页查询界面
- 支持本地运行
- 支持部署到 Cloudflare Workers

## 项目结构

- [server.js](D:\code\my\VCodeQuery\server.js)
  本地 Node 服务入口，用于本地开发和调试
- [worker.mjs](D:\code\my\VCodeQuery\worker.mjs)
  Cloudflare Workers 入口
- [public/index.html](D:\code\my\VCodeQuery\public\index.html)
  前端页面结构
- [public/styles.css](D:\code\my\VCodeQuery\public\styles.css)
  前端样式
- [public/app.js](D:\code\my\VCodeQuery\public\app.js)
  前端交互逻辑
- [wrangler.jsonc](D:\code\my\VCodeQuery\wrangler.jsonc)
  Cloudflare Workers 配置
- [.env.example](D:\code\my\VCodeQuery\.env.example)
  本地环境变量示例
- [deployment.md](D:\code\my\VCodeQuery\deployment.md)
  部署与运行说明

## 工作流程

1. 用户在页面输入邮箱地址
2. 后端登录邮箱中转站 API
3. 查询账号列表并匹配目标邮箱
4. 读取该邮箱最新邮件
5. 从邮件主题或内容中提取验证码
6. 将结果返回到页面展示

## 已接入的邮箱中转站接口

- `POST /login`
- `GET /account/list`
- `GET /email/list`
- `GET /email/latest`

## 环境变量

本项目使用以下环境变量：

- `MAIL_GATEWAY_ACCOUNTS`
  邮箱中转站登录账号列表，JSON 数组格式，支持多个账号
- `MAIL_GATEWAY_LOGIN_EMAIL`
  单个邮箱中转站登录邮箱，兼容旧配置
- `MAIL_GATEWAY_PASSWORD`
  单个邮箱中转站登录密码，兼容旧配置
- `MAIL_GATEWAY_BASE_URL`
  邮箱中转站 API 地址，默认值为 `https://mail.970410.xyz/api`
- `PORT`
  本地 Node 服务端口，默认值为 `3000`

## 开发说明

- 本地 Node 版本支持自动读取项目根目录 `.env`
- Cloudflare Workers 版本使用 `wrangler secret` 管理线上敏感配置
- 当前前端页面为纯静态资源，由本地服务或 Workers 静态资源能力提供
- 查询时会优先使用 `MAIL_GATEWAY_ACCOUNTS` 中的账号列表轮询匹配目标邮箱

## 运行与部署

完整运行和部署说明请查看：

- [deployment.md](D:\code\my\VCodeQuery\deployment.md)
