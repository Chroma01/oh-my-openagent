import { afterAll, describe, expect, mock, test } from "bun:test"

// Platform contract (#7144): every Claude-compatible hook command runs through this one spawn with
// `shell: true`, so on Windows the child is cmd.exe or bash.exe, both console-subsystem binaries. A
// console-less host (an IDE- or GUI-launched `opencode serve`) that spawns one without windowsHide
// gets a FRESH console per hook: a conhost flash that echoes the hook JSON, or on Windows 11 with
// Windows Terminal as the default terminal, a full terminal window that takes focus. The flag is inert
// on posix, so the options handed to node:child_process are the only place this is provable off Windows.

const captured: Array<Record<string, unknown>> = []

mock.module("node:child_process", () => ({
  spawn: (_command: string, options: Record<string, unknown>) => {
    captured.push(options)
    return {
      pid: 4242,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { on: () => {}, write: () => {}, end: () => {} },
      on: (event: string, handler: (code: number) => void) => {
        if (event === "close") queueMicrotask(() => handler(0))
      },
    }
  },
}))

afterAll(() => {
  mock.restore()
})

const { executeHookCommand } = await import("./execute-hook-command")

describe("executeHookCommand Windows console visibility (#7144)", () => {
  test("#given a hook command #when it is dispatched #then the shell child is spawned without a console window", async () => {
    // given
    captured.length = 0

    // when
    const result = await executeHookCommand("echo hook", '{"hook_event_name":"UserPromptSubmit"}', process.cwd())

    // then
    expect(result.exitCode).toBe(0)
    expect(captured).toHaveLength(1)
    expect({ shell: captured[0]?.shell, windowsHide: captured[0]?.windowsHide }).toEqual({ shell: true, windowsHide: true })
  })
})
