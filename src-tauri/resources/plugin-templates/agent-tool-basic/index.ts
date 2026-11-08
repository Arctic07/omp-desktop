// @ts-nocheck — 模板文件，不引入任何依赖。
// 引擎在 agent 进程内直接 import 这个模块，并把 ExtensionAPI 作为唯一参数传给它默认导出的工厂。
// 装了 @oh-my-pi/pi-coding-agent 之后可以去掉这一行，改用
// `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"` 拿到类型提示（类型导入在装载时被擦除，不产生运行时依赖）。

/**
 * 引擎侧入口（`package.json` 的 `omp.extensions`）：与 agent 同权运行，不需要 node_modules、
 * 不需要打包，禁用插件即不装载。
 *
 * 装载期只做注册（`pi.on(...)` / `pi.registerTool(...)` / `pi.registerCommand(...)`）；
 * 会话动作（`sendMessage`、`setModel` 等）要等 runner 初始化后调用才生效。
 */
export default function agentToolBasic(pi) {
  // 每次会话装载时提示一次，用来确认插件确实被加载了。
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("agent-tool-basic 已加载：试试 /hello 命令或 greet 工具。", "info");
  });

  // 斜杠命令：/hello [名字]
  // 命令名会与其它来源（内置命令、其它插件、用户自己的命令）共用一个命名空间，落地前记得改名。
  pi.registerCommand("hello", {
    description: "向对话里发一条问候",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      pi.sendMessage(
        {
          customType: "agent-tool-basic",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false },
      );
      ctx.ui.notify("已发送问候。", "info");
    },
  });
}
