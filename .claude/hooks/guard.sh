#!/bin/bash
# Claude Code / Codex 共用的 advisory 钩子：在高风险操作旁提供事实提醒。
#
# 设计原则：
#  1. **永远 exit 0**——这是提醒层，不是安全边界；钩子出错绝不能挡住用户干活。
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

input_text() {
  printf '%s' "$payload" | python3 -c '
import json,sys
try:
    tool_input=json.load(sys.stdin).get("tool_input", {})
    if isinstance(tool_input, str):
        print(tool_input)
    elif isinstance(tool_input, dict):
        print("\n".join(v for k,v in tool_input.items()
              if k in {"command","cmd","file_path","path","patch","input"} and isinstance(v,str)))
except Exception:
    pass
' 2>/dev/null
}

git_mutation() {
  printf '%s' "$1" | python3 -c '
import os,re,shlex,sys
ACTIONS={"add","commit","stash"}
TAKES_VALUE={"-C","-c","--git-dir","--work-tree","--namespace","--super-prefix","--config-env"}

def words(command):
    lexer=shlex.shlex(command, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split=True
    lexer.commenters=""
    return list(lexer)

def invocation(tokens):
    while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
        tokens=tokens[1:]
    if not tokens:
        return False
    exe=os.path.basename(tokens[0])
    if exe in {"command","nohup"}:
        rest=tokens[1:]
        while rest and rest[0].startswith("-"):
            rest=rest[1:]
        return invocation(rest)
    if exe == "env":
        rest=tokens[1:]
        while rest and (rest[0].startswith("-") or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=",rest[0])):
            option=rest.pop(0)
            if option in {"-u","--unset","-C","--chdir"} and rest:
                rest.pop(0)
        return invocation(rest)
    if exe == "sudo":
        rest=tokens[1:]
        while rest and rest[0].startswith("-"):
            option=rest.pop(0)
            if option in {"-u","-g","-h","-p","-C","-T","-R","-r","-t","--user","--group","--host","--prompt","--chdir"} and rest:
                rest.pop(0)
        return invocation(rest)
    if exe in {"sh","bash","zsh"}:
        for i,arg in enumerate(tokens[1:],1):
            if arg.startswith("-") and "c" in arg[1:] and i+1 < len(tokens):
                return matches(tokens[i+1])
        return False
    if exe != "git":
        return False
    args=tokens[1:]
    while args and args[0].startswith("-"):
        option=args.pop(0)
        if option in TAKES_VALUE and args:
            args.pop(0)
    return bool(args and args[0] in ACTIONS)

def matches(command):
    segment=[]
    for token in words(command):
        if token and all(char in ";&|()" for char in token):
            if invocation(segment):
                return True
            segment=[]
        else:
            segment.append(token)
    return invocation(segment)

sys.exit(0 if matches(sys.stdin.read()) else 1)
' 2>/dev/null
}

emit_warning() {
  python3 -c 'import json,sys; print(json.dumps({"systemMessage": sys.stdin.read().rstrip()}, ensure_ascii=False))'
}

case "$MODE" in
  git)
    cmd="$(field command)"
    [ -n "$cmd" ] || cmd="$(field cmd)"
    # 识别绝对路径、git 全局参数、env/command 包装和 shell -c，且绝不 eval 用户命令。
    git_mutation "$cmd" || exit 0

    untracked="$(git status --porcelain -uall 2>/dev/null | /usr/bin/grep '^??' | sed 's/^?? //')"
    [ -z "$untracked" ] && exit 0

    {
      echo "⚠ advisory / parallel-sessions：工作区有 $(printf '%s\n' "$untracked" | wc -l | tr -d ' ') 个未跟踪文件。"
      echo "  钩子不会阻止命令；逐个确认归属，不确定就用 git add <具体路径> 而不是宽泛暂存："
      printf '%s\n' "$untracked" | head -15 | sed 's/^/    /'
      n=$(printf '%s\n' "$untracked" | wc -l | tr -d ' ')
      [ "$n" -gt 15 ] && echo "    …另有 $((n-15)) 个"
    } | emit_warning
    ;;

  schema)
    p="$(input_text | /usr/bin/grep -oE '(^|/|[[:space:]])src/db/schema/[A-Za-z0-9._/-]+' | head -1 | sed -E 's#^[[:space:]/]*##')"
    [ -n "$p" ] || exit 0
    {
      echo "⚠ advisory / schema-change：刚改了 ${p}。"
      echo "  钩子不会证明迁移完整；仍需 drizzle-kit generate → 重启 dev server → 查 /api/health drift。"
    } | emit_warning
    ;;
esac

exit 0
