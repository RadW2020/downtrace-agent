# The recording in demo.gif: a coding agent (Claude Code with Haiku) is asked for a feature, introduces an N+1,
# `downtrace check` exits 1 and the agent fixes it. Nothing is scripted after the request, so every take differs.
#
# The scene is express-pg-jest plus scene.patch, under git, with the README's snippet as its CLAUDE.md:
#
#   cp -R examples/express-pg-jest /tmp/shop-api && cd /tmp/shop-api && rm n-plus-one.patch
#   git init -q && git apply /path/to/examples/demo/scene.patch
#   echo 'Before pushing, run `npx downtrace check`. If it exits 1, fix the routes it lists or explain why the change is intended.' > CLAUDE.md
#   echo node_modules > .gitignore && npm install && npm run db && npx downtrace init
#   git add -A && git commit -qm "shop api"
#
# The coding agent must be allowed to run commands without asking (Claude Code: auto mode), and the folder trusted
# once before recording. Then `vhs demo.tape`, cut the idle tail, and cover what the banner says of your account:
#
#   ffmpeg -i take.mp4 -t 57 -vf "fps=5,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" demo.gif

Output take.mp4

Set Shell bash
Set FontSize 14
Set Width 1280
Set Height 760
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "cd /tmp/shop-api && export PS1='shop-api $ ' && clear" Enter
Sleep 1s
Show

Type "cat CLAUDE.md" Enter
Sleep 2s
Type `claude --model haiku "GET /posts should return each post in the same shape as GET /posts/:id. I'll push when you're done."` Enter
Sleep 120s
