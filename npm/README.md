# restclient cli

Run `.http` files from the terminal (the command is `restclient`; the package is `@vscode-restclient/cli` because npm reserves names too close to an unrelated `http-keeper`). Same format as VS Code's REST Client and JetBrains' HTTP Client: requests, `# @name`, `{{variables}}`, `http-client.env.json` environments, `import` / `run #name`, `# @assert` checks, `text/event-stream` and `WEBSOCKET`.

```console
$ npx @vscode-restclient/cli api.http --env dev --secret API_KEY=… --junit report.xml
  ok   login                200  184 ms
  ok   facturas             200    9 ms

2 requests, all green
```

Exit code 0 when every assertion passes, 1 when one fails, `--json` for machines, `--junit` for CI dashboards. `restclient mcp` starts an MCP server so agents (Claude Code, Cursor, Copilot) can run your `.http` files as a tool.

This is the runner of the [Vscode Rest Client](https://marketplace.visualstudio.com/items?itemName=vscode-restclient.restclient) VS Code extension, a maintained fork of REST Client by Huachao Mao (MIT). Docs and source: https://github.com/vscode-restclient/vscode-restclient
