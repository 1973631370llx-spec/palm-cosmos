import io
p='README.md'; s=io.open(p,encoding='utf-8').read()
old_start = s.index('- 首次打开要下载 wasm')
old_end = s.index('- 之后浏览器缓存，秒开')
new = '''- 大文件全部走国内快的来源：three / MediaPipe wasm 走阿里 npm 镜像（实测 6–10MB/s），手部模型走 Google 源并备了一条 GitHub 加速通道；本站只出几十 KB 的页面骨架
- 实测冷启动（直连、手机视口 390×844）：首屏约 7–8 s，进度条到 100% 约 12 s，点「开启掌心」后 1.5 s 进场景；桌面约 6.5 s 就绪、1.4 s 进场景
- 网络特别慢时，8 秒后会出现「先进去玩 · 手部识别稍后自动开启」按钮：先看星系，模型下完自动切成手势模式
'''
s = s[:old_start] + new + s[old_end:]
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
print('readme ok')
