const text1 = "[Image blocked: 2026云南昆明石林风景区旅游攻略 「附天气＋门票＋景点＋交通」]"
const text2 = "[Image blocked: 中国公认必吃的10大昆明特色！ 1.过桥米线一代表地：昆明]"
const regex = /\[Image blocked:[^\]]*\](?:\([^)]*\))?/gi

console.log(text1.replace(regex, ""))
console.log(text2.replace(regex, ""))
