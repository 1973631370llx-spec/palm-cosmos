import io
p='js/hands.js'; s=io.open(p,encoding='utf-8').read()
s = s.replace("""    const race = (urls, onBytes) =>""", """    const race = (urls, raw, onBytes) =>""")
s = s.replace("""          const est = estimate(url, i === urls.length - 1 && !cdn ? TASK_RAW : WASM_RAW);""", """          const est = estimate(url, raw);""")
s = s.replace("""          race(wasmSources, track(0)),
          race(taskSources, track(1)),""", """          race(wasmSources, WASM_RAW, track(0)),
          race(taskSources, TASK_RAW, track(1)),""")
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
print('ok')
