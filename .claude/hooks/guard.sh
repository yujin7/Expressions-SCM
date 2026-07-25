#!/bin/bash
# Claude Code 钩子：把「靠记性」的两条纪律变成确定性检查。
#
# 设计原则：
#  1. **永远 exit 0**——钩子出错绝不能挡住用户干活。任何异常一律静默放行。
#  2. **给事实，不给唠叨**——直接跑检查并输出真实结果（谁的未跟踪文件、漂移与否），
#     而不是打印一句「请注意…」。提醒会被忽略，事实不会。
#  3. **命中才说话**——不相关的调用零输出，否则很快就没人看了。
#
# 用法：settings.json 的 hooks 里以 `bash <此文件> <mode>` 调用。
set -u
MODE="${1:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 0
cd "$REPO" 2>/dev/null || exit 0

payload="$(cat 2>/dev/null)" || exit 0

# 从钩子 stdin 的 JSON 里取字段；取不到就当空，绝不报错
field() {
  printf '%s' "$payload" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    v=d.get('tool_input',{}).get('$1','')
    print(v if isinstance(v,str) else '')
except Exception:
    print('')
" 2>/dev/null
}

case "$MODE" in
  git)
    cmd="$(field command)"
    # 只在真的要提交/暂存时介入
    printf '%s' "$cmd" | /usr/bin/grep -qE 'git (add|commit|stash)' || exit 0

    untracked="$(git status --porcelain -uall 2>/dev/null | /usr/bin/grep '^??' | sed 's/^?? //')"
    [ -z "$untracked" ] && exit 0

    echo "⚠ parallel-sessions：工作区有 $(printf '%s\n' "$untracked" | wc -l | tr -d ' ') 个未跟踪文件。"
    echo "  另一个会话若正在改这个仓库，git add -A 会把它做到一半的东西一起提交进来（本项目已发生过）。"
    echo "  逐个确认是不是你写的，不确定就用 git add <具体路径> 而不是 -A："
    printf '%s\n' "$untracked" | head -15 | sed 's/^/    /'
    n=$(printf '%s\n' "$untracked" | wc -l | tr -d ' ')
    [ "$n" -gt 15 ] && echo "    …另有 $((n-15)) 个"
    ;;

  schema)
    p="$(field file_path)"
    printf '%s' "$p" | /usr/bin/grep -q 'src/db/schema/' || exit 0
    echo "⚠ schema-change：刚改了 $(basename "$p")。"
    echo "  PGlite 只在进程启动时应用迁移，HMR 不会重放（迁移循环在 createDb() 里，promise 钉在 globalThis）。"
    echo "  漏掉重启，坏的不只是新列——drizzle 的无列名 db.select().from(t) 会展开 schema 里全部列，"
    echo "  该表的每一次读取都会 500（本仓 127 处这么写）。顺序：drizzle-kit generate → 重启 dev server → 查 /api/health 的 drift。"
    ;;
esac

exit 0
