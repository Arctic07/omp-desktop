// @ts-nocheck — 模板文件，不引入任何依赖。
// 引擎把工具 API（下面的 `pi` 参数）注入给默认导出的工厂，所以这个模块没有 import，
// 也不需要 node_modules：`tools/` 目录里的 `.ts`/`.js` 会被直接装载（`.md`/`.json` 只是元数据，不装载）。

/**
 * 自定义工具模块（引擎惯例目录 `tools/`）。
 *
 * 形状：默认导出 = 工厂，收到注入的 API，返回一个工具对象（或工具数组）。文件名只用于发现，
 * 模型看到的工具名是下面的 `name`；参数 schema 用注入的 `pi.zod`（同一 ZOD 兼容层，
 * 也可以换成 `pi.arktype` / `pi.typebox`），返回值是 `{ content, details }`。
 *
 * 注意：
 * - 工具名在整个会话里必须唯一（与内置工具、其它插件冲突即装载失败）；
 * - `execute(toolCallId, params, onUpdate, ctx, signal)` 抛错即工具失败，取消用 `signal`；
 * - 工具与 agent 同权运行：能力边界靠用户的同意，不是沙箱。
 */
export default function greet(pi) {
  return {
    name: "greet",
    label: "Greet",
    description: "返回一句带着给定名字的问候。",
    parameters: pi.zod.object({
      name: pi.zod.string().describe("要问候的名字"),
    }),
    async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: { name: params.name },
      };
    },
  };
}
