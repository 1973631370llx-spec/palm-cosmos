import io
p='js/hud.js'; s=io.open(p,encoding='utf-8').read()
s=s.replace("' · 首次约 20 秒'","' · 首次几秒'")
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
p='index.html'; s=io.open(p,encoding='utf-8').read()
s=s.replace('app.js?v=5','app.js?v=6').replace('style.css?v=5','style.css?v=6')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
print('ok')
