import io
p='js/config.js'; s=io.open(p,encoding='utf-8').read()
s=s.replace("""    cdnModel:
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',""",
"""    cdnModel:
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    // 模型备胎：Google 源在国内常被墙，备一条 GitHub 加速通道
    cdnModelAlt: 'https://ghfast.top/https://raw.githubusercontent.com/1973631370llx-spec/palm-cosmos/main/vendor/mediapipe/hand_landmarker.task',""")
io.open(p,'w',encoding='utf-8',newline='\n').write(s)

p='js/hands.js'; s=io.open(p,encoding='utf-8').read()
s=s.replace("""    const taskSources = cdn ? [CONFIG.hand.cdnModel, localTask + suffix] : [localTask + suffix, localTask];""",
"""    const taskSources = cdn
      ? [CONFIG.hand.cdnModel, CONFIG.hand.cdnModelAlt + suffix, localTask + suffix]
      : [localTask + suffix, localTask];""")
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
print('ok')
