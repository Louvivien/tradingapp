"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs = require("fs");
var anthropic = require("@anthropic-ai/sdk");
require("dotenv/config");
var apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
    throw new Error("The ANTHROPIC_API_KEY environment variable must be set");
}
var client = new anthropic.Client(apiKey);
function analyzeSentiment(headline) {
    return __awaiter(this, void 0, void 0, function () {
        var promptBase, prompt, response, sentiment, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    promptBase = "Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer \"YES\" if good news, \"NO\" if bad news, or \"UNKNOWN\" if uncertain in the first line. Then elaborate with one short and concise sentence on the next line.";
                    prompt = "".concat(anthropic.HUMAN_PROMPT).concat(promptBase, " ").concat(headline, " ").concat(anthropic.AI_PROMPT);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, client.complete({
                            prompt: prompt,
                            stop_sequences: [anthropic.HUMAN_PROMPT],
                            model: 'claude-v1',
                            max_tokens_to_sample: 100,
                            temperature: 0
                        })];
                case 2:
                    response = _a.sent();
                    console.log(response);
                    sentiment = response.completion;
                    return [2 /*return*/, sentiment];
                case 3:
                    error_1 = _a.sent();
                    console.error(error_1);
                    throw error_1;
                case 4: return [2 /*return*/];
            }
        });
    });
}
function processNews() {
    return __awaiter(this, void 0, void 0, function () {
        var newsData, newsList, updatedNewsList, _i, newsList_1, article, headline, sentiment, _a, sentimentValue, description;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, fs.promises.readFile('news.json', 'utf8')];
                case 1:
                    newsData = _b.sent();
                    newsList = JSON.parse(newsData);
                    updatedNewsList = [];
                    _i = 0, newsList_1 = newsList;
                    _b.label = 2;
                case 2:
                    if (!(_i < newsList_1.length)) return [3 /*break*/, 6];
                    article = newsList_1[_i];
                    headline = article['News headline'];
                    return [4 /*yield*/, analyzeSentiment(headline)];
                case 3:
                    sentiment = _b.sent();
                    _a = sentiment.split('\n'), sentimentValue = _a[0], description = _a[1];
                    article['Sentiment'] = sentimentValue.trim();
                    article['Description'] = description;
                    updatedNewsList.push(article);
                    // Esperar 1 segundo antes de la siguiente iteración
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1000); })];
                case 4:
                    // Esperar 1 segundo antes de la siguiente iteración
                    _b.sent();
                    _b.label = 5;
                case 5:
                    _i++;
                    return [3 /*break*/, 2];
                case 6: return [4 /*yield*/, fs.promises.writeFile('salida_claude_3.json', JSON.stringify(updatedNewsList, null, 4))];
                case 7:
                    _b.sent();
                    console.log('Archivo de salida creado exitosamente: salida_claude_3.json');
                    return [2 /*return*/];
            }
        });
    });
}
processNews().catch(function (error) {
    console.error('Error:', error);
});
