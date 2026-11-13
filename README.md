<div align="center">

# 📚 Bookshelf Connector

### An [Obsidian](https://obsidian.md) plugin

Import **Audible audiobooks** and **NovelPhoenix web novels** as rich
[Bookshelf](https://github.com/weph/obsidian-bookshelf) book notes —
covers, metadata, series, and reading progress included.

[![Version](https://img.shields.io/badge/version-2.0.0-blue?style=flat-square)](https://github.com/YOURUSERNAME/obsidian-bookshelf-connector/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.10.0%2B-8a5cf6?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](#-license)

</div>

---

## ✨ What it does

> Point it at an Audible page or a NovelPhoenix novel and get a fully
> populated Bookshelf note: cover, author, genre, series, runtime or chapter
> count, and a ready-made reading-journal heading. No manual typing, no copy-paste.

<div align="center">

<!-- Replace this with a screenshot of your Bookshelf library view -->
<!-- ![Library view](docs/library.png) -->

*📸 Add a screenshot of your Bookshelf library here*

</div>

## 🚀 Features

### 🎧 Audible audiobooks
- 🔍 **Search by title** — live result picker, filter by adding the author
- 🔗 **Import by URL or bare ASIN** — paste a link or just `B0XXXXXXXX`
- 🌍 **10 marketplaces** — `com`, `co.uk`, `de`, `fr`, `it`, `es`, `ca`, `com.au`, `in`, `jp`
- ⏱️ **Runtime** captured as a Bookshelf `duration` (`11:20` for 11h 20m)
- 🎙️ **Narrator** recorded
- 📚 **Series + position** filled in automatically
- 🏷️ **Genres** from Audible's category ladders

### 📖 NovelPhoenix web novels
- 📄 **Chapter-count scraping** — reads the site's declared count and discovered links
- 🔢 **Inferred chapter links** — when the site only exposes a few, the rest are generated from the count
- 🔄 **Refresh chapter count** — update an ongoing novel's total in one click
- 👤 **Author & genres** pulled from the novel page

### 🏷️ Bookshelf integration
- ✅ Writes **Bookshelf-compatible frontmatter** using its default property names
- 📈 Creates a **Reading Journey** heading so progress tracking works out of the box
- 🎯 Tracks **web-novel chapters as pages**, so Bookshelf's percentages and stats just work
- 🔁 **Migrates notes** from the older Library-plugin format

### ⚙️ Under the hood
- 🖼️ **Cover downloads** into a vault folder (referenced as `[[wikilinks]]`)
- 🛡️ **Never overwrites** your `rating` or `comment`
- 🆔 Deduplicates on Audible ASIN / NovelPhoenix slug — re-imports update, not duplicate
- 🔑 **No API keys required** — Audible's catalog API is keyless

## 🖼️ Screenshots

<!-- Add screenshots here, e.g. -->
<!-- | Audible search | Audiobook note |
  |---|---|
  | ![search](docs/search.png) | ![note](docs/note.png) | -->

*Coming soon.*

## 📦 Installation

### From a GitHub Release (recommended)
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/YOURUSERNAME/obsidian-bookshelf-connector/releases).
2. Place them in your vault at `.obsidian/plugins/media-library/`.
   > ⚠️ The folder name **must** match the `id` in `manifest.json`.
3. Restart Obsidian → **Settings → Community plugins** → enable **Bookshelf Connector**.

> This plugin requires the [Bookshelf](https://github.com/weph/obsidian-bookshelf) plugin
> to be installed for its library views to work.

### Via BRAT (auto-updates)
If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat), add this repo as a beta
plugin and it will pull releases and update automatically.

## 🎛️ Commands

Open the command palette (`Ctrl/Cmd + P`):

| Command | What it does |
|---|---|
| 🔍 `Search Audible by title` | Search and pick an audiobook interactively |
| 🎧 `Import audiobook from Audible URL or ASIN` | Import from a pasted link or ASIN |
| 📖 `Import web novel from NovelPhoenix URL` | Import a web novel by URL |
| 🔄 `Refresh chapter count for current novel` | Re-scrape an open novel's chapter total |
| 🔁 `Migrate Library-format notes to Bookshelf` | One-shot conversion of old Library notes |

## ⚙️ Settings

Found under **Settings → Bookshelf Connector**:

| Setting | Default | Description |
|---|---|---|
| 📁 Books folder | `Books` | Must match Bookshelf's **Books folder** setting |
| 🖼️ Covers folder | `Books/covers` | Where downloaded covers are saved |
| 📈 Reading journey heading | `Reading Journey` | Heading Bookshelf reads progress from |
| 🌍 Audible marketplace | `com` | Region for searches and imports |
| ⬇️ Download covers | `on` | Save covers into the vault |
| 🔢 Infer NovelPhoenix chapters | `on` | Generate chapter links from the declared count |

## 🗂️ How it maps to Bookshelf

**Audible audiobook**

| Bookshelf property | Source |
|---|---|
| `title` | Product title |
| `author` | Authors |
| `cover` | Product image (downloaded, as `[[link]]`) |
| `duration` | Runtime, as `H:MM` |
| `genre` | Category ladders |
| `series` / `position-in-series` | Series title / order |
| `links` | Audible product URL |
| `narrator` *(custom)* | Narrators |
| `audible-asin` *(custom)* | ASIN — used for dedupe |

**NovelPhoenix web novel**

| Bookshelf property | Source |
|---|---|
| `title` | Novel title |
| `author` | Author |
| `cover` | Cover image (downloaded, as `[[link]]`) |
| `pages` | Chapter count *(chapters tracked as pages)* |
| `genre` | Genre tags |
| `tags` | `webnovel` |
| `links` | NovelPhoenix URL |
| `novelphoenix-slug` *(custom)* | Slug — used for dedupe |

## 🔨 Build from source

Requires [Node.js](https://nodejs.org) v18+.

```bash
git clone https://github.com/YOURUSERNAME/obsidian-bookshelf-connector.git
cd obsidian-bookshelf-connector
npm install
npm run dev
