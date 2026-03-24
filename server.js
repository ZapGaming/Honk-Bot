import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import cors from 'cors';;

const app = express();
app.use(cors());
app.use(express.json());

// Cache DB connections to prevent exhausting Mongo connection limits
const dbConnections = {};

// Helper: Get or create dynamic Mongo model
async function getChatModel(mongoUri) {
    if (!dbConnections[mongoUri]) {
        const conn = await mongoose.createConnection(mongoUri).asPromise();
        const chatSchema = new mongoose.Schema({
            userId: String,
            role: String,
            content: String,
            timestamp: { type: Date, default: Date.now }
        });
        dbConnections[mongoUri] = conn.model('ChatMessage', chatSchema);
    }
    return dbConnections[mongoUri];
}

// Helper: Execute Web Search with API Key
async function executeWebSearch(searchEndpoint, searchApiKey, query) {
    try {
        const response = await axios.post(searchEndpoint, 
            { query: query },
            { 
                headers: { 
                    'Authorization': `Bearer ${searchApiKey}`,
                    'x-api-key': searchApiKey,
                    'Content-Type': 'application/json'
                } 
            }
        );
        return JSON.stringify(response.data);
    } catch (error) {
        console.error("Search API Error:", error.message);
        return JSON.stringify({ error: "Failed to fetch search results." });
    }
}

app.post('/v1/chat/completions', async (req, res) => {
    const {
        api_endpoint,
        api_key,
        mongo_uri,
        model,
        system_role,
        prompt,
        search_api_endpoint,
        search_api_key,
        user_id = "default_user" 
    } = req.body;

    if (!api_endpoint || !api_key || !mongo_uri || !prompt) {
        return res.status(400).json({ error: "Missing required fields in payload." });
    }

    try {
        // 1. Fetch Chat History
        const Chat = await getChatModel(mongo_uri);
        const history = await Chat.find({ userId: user_id }).sort({ timestamp: 1 }).limit(10);
        
        let messages = [
            { role: "system", content: system_role || "You are a helpful AI assistant." },
            ...history.map(msg => ({ role: msg.role, content: msg.content })),
            { role: "user", content: prompt }
        ];

        // 2. Prepare Web Search Tool (if endpoint is provided)
        let tools = [];
        if (search_api_endpoint && search_api_key) {
            tools.push({
                type: "function",
                function: {
                    name: "web_search",
                    description: "Search the web for up-to-date information.",
                    parameters: {
                        type: "object",
                        properties: { query: { type: "string", description: "The search query" } },
                        required: ["query"]
                    }
                }
            });
        }

        const requestPayload = {
            model: model || "gpt-3.5-turbo",
            messages: messages,
            ...(tools.length > 0 && { tools: tools, tool_choice: "auto" })
        };

        // 3. First AI API Call
        let aiResponse = await axios.post(api_endpoint, requestPayload, {
            headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' }
        });

        let responseMessage = aiResponse.data.choices[0].message;

        // 4. Handle Tool Calls (Web Search)
        if (responseMessage.tool_calls) {
            messages.push(responseMessage);

            for (let toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "web_search") {
                    const args = JSON.parse(toolCall.function.arguments);
                    const searchResults = await executeWebSearch(search_api_endpoint, search_api_key, args.query);
                    
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name,
                        content: searchResults
                    });
                }
            }

            // Second AI API Call with tool results
            const secondPayload = { model: model, messages: messages };
            aiResponse = await axios.post(api_endpoint, secondPayload, {
                headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' }
            });
            responseMessage = aiResponse.data.choices[0].message;
        }

        // 5. Save to MongoDB
        await Chat.create([
            { userId: user_id, role: "user", content: prompt },
            { userId: user_id, role: "assistant", content: responseMessage.content }
        ]);

        // 6. Return response to BotGhost
        res.json({
            id: aiResponse.data.id || `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: { role: "assistant", content: responseMessage.content },
                finish_reason: "stop"
            }]
        });

    } catch (error) {
        console.error("Proxy Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Internal Server Error during AI processing." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
