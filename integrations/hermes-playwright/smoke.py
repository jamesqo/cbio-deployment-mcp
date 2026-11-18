"""Check the installed launcher via MCP, without contacting an external website."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def check():
    launcher = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="smoke-", dir=launcher.parent) as output:
        env = dict(os.environ, HERMES_PLAYWRIGHT_ARTIFACTS=output)
        params = StdioServerParameters(command=str(launcher), env=env)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {tool.name for tool in (await session.list_tools()).tools}
                required = {"browser_navigate", "browser_evaluate", "browser_take_screenshot"}
                assert required <= tools, "Browser tools are missing"
                calls = [
                    ("browser_navigate", {"url": "about:blank"}),
                    ("browser_evaluate", {"function": '() => { document.body.innerHTML = "<h1>Engineer native browser</h1>"; return document.body.innerText; }'}),
                    ("browser_take_screenshot", {"type": "png", "filename": "smoke.png"}),
                ]
                for name, arguments in calls:
                    result = await session.call_tool(name, arguments)
                    assert not result.isError, f"{name} failed: {result}"
                assert (Path(output) / "smoke.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
                await session.call_tool("browser_close", {})
                print(f"PASS: {len(tools)} tools; native launcher navigation, JavaScript, PNG screenshot")


asyncio.run(asyncio.wait_for(check(), timeout=60))
