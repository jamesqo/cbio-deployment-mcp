# Direct Playwright MCP for Hermes Engineer

This launcher replaces the separate `docker run` browser used by Engineer.
The browser and MCP run as child processes inside Engineer's environment.
The outer container is still managed by the host; this removes the browser's
need for a Docker daemon, not Engineer's other deployment tools.

The lockfile pins MCP 0.0.82 and Playwright 1.64.0-alpha-1789764292000 to match
Engineer's previous browser image. Node, npm and Chromium system libraries must
be present. The installer downloads the platform-specific browsers into the
persistent target directory. It does not install OS packages or change Hermes
configuration.

```sh
./install.sh /opt/data/tools/playwright-native
```

Configure the `playwright` entry in the engineering profile's `mcp_servers`:

```yaml
playwright:
  command: /opt/data/tools/playwright-native/run.sh
  args: []
  env:
    HERMES_PLAYWRIGHT_ARTIFACTS: /Users/jko/Code/cbio-engineer/work/artifacts
```

Use a writable artifact path appropriate for the target host. The launcher
changes into that directory because relative screenshot filenames are resolved
against the working directory. Isolated browsing, headless Chromium and the
existing no-sandbox behavior are preserved. The browser now shares Engineer's
container resource limit; account for that in pod/container sizing.

Verify under the same user as the gateway before reloading its configuration:

```sh
python smoke.py /opt/data/tools/playwright-native/run.sh
```

This uses the Python MCP SDK included in Hermes, loads the tools, navigates a
blank page, executes JavaScript, and validates an actual PNG screenshot from a
relative filename. Test files are removed afterward. No Slack message is sent.
