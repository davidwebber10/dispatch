// Real JSON-RPC frames captured from a live `codex app-server` (codex-cli 0.144.4,
// model gpt-5.6-sol) driving one turn that streams assistant text, runs a shell
// command, and requests a file-change approval. Used as canned fixtures for the
// translation-layer unit tests so they exercise the EXACT wire shapes the server emits.
// Captured 2026-07-16 via the Phase B connection spike (see PR notes). DO NOT hand-edit;
// regenerate by re-running the spike if the protocol changes.

/* eslint-disable */

export const threadStarted = {
  "method": "thread/started",
  "params": {
    "thread": {
      "id": "019f6cfa-33af-7480-bed7-948b4d900c94",
      "extra": null,
      "sessionId": "019f6cfa-33af-7480-bed7-948b4d900c94",
      "forkedFromId": null,
      "parentThreadId": null,
      "preview": "",
      "ephemeral": false,
      "historyMode": "legacy",
      "modelProvider": "openai",
      "createdAt": 1784239767,
      "updatedAt": 1784239767,
      "recencyAt": 1784239767,
      "status": {
        "type": "idle"
      },
      "path": "/Users/davidwebber/.codex/sessions/2026/07/16/rollout-2026-07-16T18-09-24-019f6cfa-33af-7480-bed7-948b4d900c94.jsonl",
      "cwd": "/var/folders/k7/xw2xpq2d4tb_4vxd3mv020800000gn/T/codex-spike-gXBxlz",
      "cliVersion": "0.144.4",
      "source": "vscode",
      "threadSource": null,
      "agentNickname": null,
      "agentRole": null,
      "gitInfo": null,
      "name": null,
      "turns": []
    }
  }
} as const;

export const turnStarted = {
  "method": "turn/started",
  "params": {
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turn": {
      "id": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
      "items": [],
      "itemsView": "notLoaded",
      "status": "inProgress",
      "error": null,
      "startedAt": 1784239767,
      "completedAt": null,
      "durationMs": null
    }
  }
} as const;

export const agentMsgStarted = {
  "method": "item/started",
  "params": {
    "item": {
      "type": "agentMessage",
      "id": "msg_01a13b656be034d1016a5956a1be408196a039f94887b9dc7c",
      "text": "",
      "phase": "commentary",
      "memoryCitation": null
    },
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "startedAtMs": 1784239777741
  }
} as const;

export const agentMsgDelta1 = {
  "method": "item/agentMessage/delta",
  "params": {
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "itemId": "msg_01a13b656be034d1016a5956a1be408196a039f94887b9dc7c",
    "delta": "I"
  }
} as const;

export const agentMsgDelta2 = {
  "method": "item/agentMessage/delta",
  "params": {
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "itemId": "msg_01a13b656be034d1016a5956a1be408196a039f94887b9dc7c",
    "delta": "’ll"
  }
} as const;

export const agentMsgCompleted = {
  "method": "item/completed",
  "params": {
    "item": {
      "type": "agentMessage",
      "id": "msg_01a13b656be034d1016a5956a1be408196a039f94887b9dc7c",
      "text": "I’ll check the workspace instructions, then create `hello.txt` with `apply_patch` exactly as requested.",
      "phase": "commentary",
      "memoryCitation": null
    },
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "completedAtMs": 1784239780115
  }
} as const;

export const cmdStarted = {
  "method": "item/started",
  "params": {
    "item": {
      "type": "commandExecution",
      "id": "exec-8ad0d935-eb3a-428f-8301-3ed1eacdc662",
      "command": "/bin/zsh -lc 'cat /Users/davidwebber/.codex/RTK.md'",
      "cwd": "/var/folders/k7/xw2xpq2d4tb_4vxd3mv020800000gn/T/codex-spike-gXBxlz",
      "processId": "90581",
      "source": "unifiedExecStartup",
      "status": "inProgress",
      "commandActions": [
        {
          "type": "read",
          "command": "cat /Users/davidwebber/.codex/RTK.md",
          "name": "RTK.md",
          "path": "/Users/davidwebber/.codex/RTK.md"
        }
      ],
      "aggregatedOutput": null,
      "exitCode": null,
      "durationMs": null
    },
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "startedAtMs": 1784239781191
  }
} as const;

export const cmdCompleted = {
  "method": "item/completed",
  "params": {
    "item": {
      "type": "commandExecution",
      "id": "exec-8ad0d935-eb3a-428f-8301-3ed1eacdc662",
      "command": "/bin/zsh -lc 'cat /Users/davidwebber/.codex/RTK.md'",
      "cwd": "/var/folders/k7/xw2xpq2d4tb_4vxd3mv020800000gn/T/codex-spike-gXBxlz",
      "processId": "90581",
      "source": "unifiedExecStartup",
      "status": "completed",
      "commandActions": [
        {
          "type": "read",
          "command": "cat /Users/davidwebber/.codex/RTK.md",
          "name": "RTK.md",
          "path": "/Users/davidwebber/.codex/RTK.md"
        }
      ],
      "aggregatedOutput": "# RTK - Rust Token Killer (Codex CLI)\n\n**Usage**: Token-optimized CLI proxy for shell commands.\n\n## Rule\n\nAlways prefix shell commands with `rtk`.\n\nExamples:\n\n```bash\nrtk git status\nrtk cargo test\nrtk npm run build\nrtk pytest -q\n```\n\n## Meta Commands\n\n```bash\nrtk gain            # Token savings analytics\nrtk gain --history  # Recent command savings history\nrtk proxy <cmd>     # Run raw command without filtering\n```\n\n## Verification\n\n```bash\nrtk --version\nrtk gain\nwhich rtk\n```\n",
      "exitCode": 0,
      "durationMs": 0
    },
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "completedAtMs": 1784239781192
  }
} as const;

export const fileChangeStarted = {
  "method": "item/started",
  "params": {
    "item": {
      "type": "fileChange",
      "id": "exec-5686ca9d-290d-4d0c-9c4f-4008cc2c4091",
      "changes": [
        {
          "path": "/var/folders/k7/xw2xpq2d4tb_4vxd3mv020800000gn/T/codex-spike-gXBxlz/hello.txt",
          "kind": {
            "type": "add"
          },
          "diff": "hi\n"
        }
      ],
      "status": "inProgress"
    },
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "startedAtMs": 1784239784949
  }
} as const;

export const fileChangeApproval = {
  "method": "item/fileChange/requestApproval",
  "id": 0,
  "params": {
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "itemId": "exec-5686ca9d-290d-4d0c-9c4f-4008cc2c4091",
    "startedAtMs": 1784239784950,
    "reason": null,
    "grantRoot": null
  }
} as const;

export const fileChangeCompleted = {
  "method": "item/completed",
  "params": {
    "item": {
      "type": "fileChange",
      "id": "exec-5686ca9d-290d-4d0c-9c4f-4008cc2c4091",
      "changes": [
        {
          "path": "/var/folders/k7/xw2xpq2d4tb_4vxd3mv020800000gn/T/codex-spike-gXBxlz/hello.txt",
          "kind": {
            "type": "add"
          },
          "diff": "hi\n"
        }
      ],
      "status": "completed"
    },
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "completedAtMs": 1784239785047
  }
} as const;

export const tokenUsage = {
  "method": "thread/tokenUsage/updated",
  "params": {
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "tokenUsage": {
      "total": {
        "totalTokens": 14589,
        "inputTokens": 14359,
        "cachedInputTokens": 9984,
        "outputTokens": 230,
        "reasoningOutputTokens": 107
      },
      "last": {
        "totalTokens": 14589,
        "inputTokens": 14359,
        "cachedInputTokens": 9984,
        "outputTokens": 230,
        "reasoningOutputTokens": 107
      },
      "modelContextWindow": 258400
    }
  }
} as const;

export const turnCompleted = {
  "method": "turn/completed",
  "params": {
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turn": {
      "id": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
      "items": [],
      "itemsView": "notLoaded",
      "status": "completed",
      "error": null,
      "startedAt": 1784239767,
      "completedAt": 1784239792,
      "durationMs": 25743
    }
  }
} as const;

export const userMessageStarted = {
  "method": "item/started",
  "params": {
    "item": {
      "type": "userMessage",
      "id": "019f6cfa-5659-7c21-a4d9-961743940431",
      "clientId": null,
      "content": [
        {
          "type": "text",
          "text": "Create a file named hello.txt containing the text hi. Use the apply_patch tool.",
          "text_elements": []
        }
      ]
    },
    "threadId": "019f6cfa-33af-7480-bed7-948b4d900c94",
    "turnId": "019f6cfa-3e60-7271-9b23-80c7d1a3a1ef",
    "startedAtMs": 1784239773273
  }
} as const;
