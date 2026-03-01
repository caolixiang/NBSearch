import { normalizeAssistantMarkdown, expandGrokRenderTags } from "./src/components/markdown-content/markdown-normalize"

const card1 = {
  id: "card1",
  image: {
    original: "Image blocked: AKB舊將鬼頭桃菜",
    thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9Gc",
    title: "Saika Kawakita",
  }
}

const card2 = {
  id: "card2",
  image: {
    original: " ", // Just a space
    thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9Gc",
    title: "Saika Kawakita",
  }
}

const raw = `<grok:render card_id="card1"/>\n<grok:render card_id="card2"/>`
const cards = { "card1": card1, "card2": card2 }
console.log(normalizeAssistantMarkdown(expandGrokRenderTags(raw, cards as any)))
