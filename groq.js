require('dotenv').config()

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { downloadMediaMessage } = require("@whiskeysockets/baileys")
// const { initializeAgentExecutorWithOptions } = require("langchain/agents")
const Groq = require("groq-sdk");
// const { DynamicTool } = require("langchain/tools")
// const { BufferWindowMemory, ChatMessageHistory } = require("langchain/memory");
// const { SystemMessage } = require('langchain/schema')
const fs = require("fs")
const axios = require("axios")
const tesseract = require("node-tesseract-ocr")
const WSF = require("wa-sticker-formatter")
const webpConverter = require("./lib/webpconverter.js")
const yargs = require('yargs/yargs')

const groq = new Groq({
  apiKey: "", // Ganti dengan API Key yang valid
});

global.yargs = yargs(process.argv).argv

const MEMORY = {}
// const chat = new ChatOpenAI({ modelName: process.env.MODEL_NAME || 'gpt-4o-mini', temperature: 0.3 });
const DATABASE_FILE = './database.json';

function readDatabase(){
	if(!fs.existsSync(DATABASE_FILE)){
		fs.writeFileSync(DATABASE_FILE, JSON.stringify({ images: {}, videos: {} }, null, 2));
	}
	return JSON.parse(fs.readFileSync(DATABASE_FILE, 'utf-8'));
}

function writeDatabase(base){
	fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2))
}

async function connectToWhatsApp() {
	const { state, saveCreds } = await useMultiFileAuthState('login')
	const { version } = await fetchLatestBaileysVersion()

	const sock = makeWASocket({
		version,
		printQRInTerminal: true,
		auth: state,
	})

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect } = update
		if (connection === 'close') {
			var _a, _b
			var shouldReconnect = ((_b = (_a = lastDisconnect.error) === null || _a === void 0 ? void 0 : _a.output) === null || _b === void 0 ? void 0 : _b.statusCode) !== DisconnectReason.loggedOut
			console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
			if (shouldReconnect) {
				connectToWhatsApp()
			}
		} else if (connection === 'open') {
			console.log('opened connection')
		}
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('messages.upsert', (m) => {
		const messageKeys = m.messages.map(message => {
			if (!message.message || message.key.fromMe || message.key && message.key.remoteJid == 'status@broadcast') {
				return null;
			}

			return message.key
		}).filter(k => k != null)

		if (messageKeys.length > 0) {
			sock.readMessages(messageKeys).catch(() => {
				console.log("Terjadi error saat membaca pesan")
			})
		}

		m.messages.forEach(async (message) => {
			if (!message.message || message.key.fromMe || message.key && message.key.remoteJid == 'status@broadcast') return
			if (message.message.ephemeralMessage) {
				message.message = message.message.ephemeralMessage.message
			}

			const myNumber = sock.user.id.split(':')[0]
			const senderNumber = message.key.remoteJid
			const isGroup = senderNumber.endsWith('@g.us')
			const imageMessage = message.message.imageMessage
			const videoMessage = message.message.videoMessage
			const stickerMessage = message.message.stickerMessage
			const extendedTextMessage = message.message.extendedTextMessage
			const quotedMessageContext = extendedTextMessage && extendedTextMessage.contextInfo && extendedTextMessage.contextInfo
			const quotedMessage = quotedMessageContext && quotedMessageContext.quotedMessage
			const textMessage = message.message.conversation || message.message.extendedTextMessage && message.message.extendedTextMessage.text || imageMessage && imageMessage.caption || videoMessage && videoMessage.caption || 'lakukuan sesuatu'
			const isMentioned = textMessage.includes('@' + myNumber)

			const database = readDatabase();

			if (isGroup && !isMentioned) {
				return
			}

			if (textMessage.toLowerCase() === 'reset percakapan kita') {
                delete MEMORY[senderNumber];
                await sock.sendMessage(senderNumber, { text: 'Percakapan telah direset!' }, { quoted: message });
                return;
            }

            MEMORY[senderNumber].history.push({
    			role: "user",
    			content: textMessage,  // Pesan dari pengguna yang diterima
			});

			if (imageMessage) {
				const image = await downloadMediaMessage(message, 'buffer')
				const id = 'img_' + Math.random().toString(36).slice(2, 7)
				database.images[id] = image.toString('base64');
				writeDatabase(database);
				await memory.chatHistory.addUserMessage(`ini id gambarnya ${id} untuk kamu proses`)
			}

			if (videoMessage && videoMessage.mimetype == "video/mp4") {
				if (videoMessage.seconds > 8) {
					// await sock.sendMessage(senderNumber, { text: 'Maksimal 8 detik kak!' }, { quoted: message })
					return 'beri tau user. bahwa maksimal durasinya adalah 8 detik'
				}

				const image = await downloadMediaMessage(message, 'buffer')
				const id = 'img_' + Math.random().toString(36).slice(2, 7)
				database.images[id] = image.toString('base64');
				writeDatabase(database);
				await memory.chatHistory.addUserMessage(`ini id videonya ${id} untuk kamu proses`)
			}

			if (stickerMessage) {
				return
			}

			try {
				await sock.sendPresenceUpdate('composing', message.key.remoteJid)
				const stream = await getGroqChatCompletion(MEMORY[senderNumber].history);
				let response = '';
				for await (const chunk of stream) {
    				const content = chunk.choices[0]?.delta?.content || "";
    				response += content;
  				}
				// const chatCompletion = await getGroqChatCompletion(MEMORY[senderNumber].history);
				response = response || "I'm sorry, I couldn't process that request.";
				await sock.sendMessage(senderNumber, { text: response }, { quoted: message });
			} catch (e) {
				if (!global.yargs.dev) {
					console.log("[ERROR] " + e.message);
					await sock.sendMessage(message.key.remoteJid, { "text": "Terjadi error! coba lagi nanti" }, { quoted: message });
				} else {
					console.log(e);
				}
			} finally {
				await sock.sendPresenceUpdate('available', message.key.remoteJid)
			}
		})
	})

}

connectToWhatsApp()

const getGroqChatStream = async (history) => {
    return groq.chat.completions.create({
        messages: [
            { role: "system", content: "Kamu adalah Zia - AI, AI yang di buat oleh Muhammad Ridho, yang telah di-programkan khusus untuk membantu Muhammad Ridho, seorang mahasiswa Politeknik Negeri Banjarmasin. Kamu memiliki kemampuan untuk membantu dalam materi bisnis, coding, dan teknologi, termasuk program Arduino, coding web, dan AI learning. Kamu dapat berkomunikasi menggunakan bahasa Indonesia yang gaul dan akrab, sehingga Orang dapat menghubungi Kamu dengan mudah dan efektif." },
            ...history,  // Include history from current user session
        ],
        model: "llama3-8b-8192",
        temperature: 0.5,
        max_tokens: 1024,
        top_p: 1,
        stop: null,
        stream: true,
    });
};