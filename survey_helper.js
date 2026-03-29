// ==UserScript==
// @name         问卷分析助手
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  问卷数据分析助手，支持信度分析、效度分析、测量模型评估和异常样本检测
// @author       Gemini-Pro & Feng Han
// @match        https://www.credamo.com/survey.html*
// @grant        none
// @license MIT
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CredamoAnalysisHelper = {
        Config: {
            reliability: {
                alphaThreshold: 0.7,
                suggestionThreshold: 0.7,
            },
            measurementModel: {
                crThreshold: 0.7,
                aveThreshold: 0.5,
                loadingThreshold: 0.7,
            },
            validity: {
                htmtThresholdStrict: 0.85,
                htmtThresholdLoose: 0.90,
            },
            abnormalSample: {
                durationRatio: 3,
                scaleTypeThreshold: 5,
                stdDevThreshold_5_point: 0.5,
                stdDevThreshold_7_point: 0.8,
                stdDevRedThreshold: 0.4,
                consecutiveThresholdMax: 15,
                zScoreThreshold: 1.96,
            },
        },

        Data: {
            processedData: new Map(),
            headerMap: new Map(),
            csvHeaders: [],
            duplicateCount: 0,
            filteredByChannelCount: 0,
            filteredByStatusCount: 0,
            clear: function() {
                this.processedData.clear();
                this.headerMap.clear();
                this.csvHeaders = [];
                this.duplicateCount = 0;
                this.filteredByChannelCount = 0;
                this.filteredByStatusCount = 0;
                CredamoAnalysisHelper.UI.isDisclaimerClosed = false;
                console.log('所有数据已清空。');
            },
            processResponse: function(responseText) {
                try {
                    const json = JSON.parse(responseText);
                    if (!json.success || !json.data || !Array.isArray(json.data.rowList)) return;
                    const { header, rowList } = json.data;
                    if (this.headerMap.size === 0 && Array.isArray(header)) {
                        const basicHeaders = new Map([
                            ['answerSign', '作答ID'], ['userSign', '用户ID'],
                            ['answerTime', '作答总时长'], ['sourceType', '作答渠道'],
                            ['status', '状态'], ['dispenseName', '问卷发布名称']
                        ]);
                        header.forEach(h => { if (h.id && h.qNum) this.headerMap.set(String(h.id), h.qNum); });
                        for (const [id, qNum] of basicHeaders.entries()) { if (!this.headerMap.has(id)) this.headerMap.set(id, qNum); }
                        this.csvHeaders = [...new Set(Array.from(this.headerMap.values()))];
                    }
                    if (this.headerMap.size === 0) return;
                    rowList.forEach(row => {
                        if (row.sourceType == 2) { this.filteredByChannelCount++; return; }
                        if (row.status != 1 && row.status != 3) { this.filteredByStatusCount++; return; }
                        const uniqueId = row.answerSign;
                        if (!uniqueId) return;
                        if (this.processedData.has(uniqueId)) {
                            this.duplicateCount++;
                        } else {
                            const newRow = {};
                            for (const [id, qNum] of this.headerMap.entries()) { if (row.hasOwnProperty(id)) newRow[qNum] = row[id]; }
                            this.processedData.set(uniqueId, newRow);
                        }
                    });
                    CredamoAnalysisHelper.UI.updatePanelDisplay();
                } catch (e) {
                    console.error('[数据助手] 处理数据时发生错误:', e);
                    CredamoAnalysisHelper.UI.showError(`脚本处理响应时出错: ${e.message}`);
                }
            },
        },

        Analysis: {
            stats: {
                mean: (arr) => {
                    if (!arr || arr.length === 0) return 0;
                    return arr.reduce((a, b) => a + b, 0) / arr.length;
                },
                variance: (arr) => {
                    if (!arr || arr.length < 2) return 0;
                    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
                    return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
                },
                pearson: (arrX, arrY) => {
                    if (arrX.length !== arrY.length || arrX.length === 0) { return NaN; }
                    const n = arrX.length;
                    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
                    for (let i = 0; i < n; i++) { const x = arrX[i]; const y = arrY[i]; sumX += x; sumY += y; sumX2 += x * x; sumY2 += y * y; sumXY += x * y; }
                    const numerator = n * sumXY - sumX * sumY;
                    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
                    return (denominator === 0) ? NaN : numerator / denominator;
                }
            },
            _getDimensions: function() {
                const dimensions = {};
                // Updated pattern to handle both "AA1" and "Q1_1" formats
                const pattern = /^([a-zA-Z_]+[a-zA-Z]?)(?:\d+|_\d+)$/;
                for (const header of CredamoAnalysisHelper.Data.csvHeaders) {
                    // Skip single question variables like "Q1", "Q2", "Q3" as they are not scales
                    if (/^Q\d+$/.test(header)) {
                        continue;
                    }
                    // Skip reverse coded variables (starting with "r_") for validity analysis
                    if (header.startsWith('r_')) {
                        continue;
                    }
                    const match = header.match(pattern);
                    if (match) {
                        let prefix = match[1];
                        // For Q1_1 format, extract just the Q1 part
                        if (header.includes('_')) {
                            const underscoreMatch = header.match(/^([a-zA-Z]+\d+)_\d+$/);
                            if (underscoreMatch) {
                                prefix = underscoreMatch[1];
                            }
                        }
                        if (!dimensions[prefix]) { dimensions[prefix] = []; }
                        dimensions[prefix].push(header);
                    }
                }
                return dimensions;
            },
            _getParsedData: function(headers) {
                const data = Array.from(CredamoAnalysisHelper.Data.processedData.values());
                const existingHeaders = data.length > 0 ? Object.keys(data[0]) : [];
                const validHeaders = headers.filter(h => existingHeaders.includes(h));
                const parsedData = data.map(row => {
                    const newRow = {...row};
                    for(const header of validHeaders) {
                        newRow[header] = parseFloat(newRow[header]);
                    }
                    return newRow;
                });
                return { parsedData, validHeaders, existingHeaders };
            },
            calculateCronbachReport: function() {
                const dimensions = this._getDimensions();
                const data = CredamoAnalysisHelper.Data.processedData;
                const results = [];
                for (const dim in dimensions) {
                    const items = dimensions[dim];
                    if (items.length < 2) continue;
                    const K = items.length;
                    const respondents = Array.from(data.values());
                    let sumOfItemVariances = 0;
                    for (const header of items) {
                        const itemData = respondents.map(row => Number(row[header])).filter(n => !isNaN(n));
                        if (itemData.length > 1) { sumOfItemVariances += this.stats.variance(itemData); }
                    }
                    const totalScores = respondents.map(row => items.reduce((sum, header) => {
                        const val = Number(row[header]);
                        return sum + (isNaN(val) ? 0 : val);
                    }, 0));
                    const totalVariance = this.stats.variance(totalScores);
                    const alpha = (totalVariance === 0) ? 0 : (K / (K - 1)) * (1 - (sumOfItemVariances / totalVariance));
                    let suggestion = null;
                    const config = CredamoAnalysisHelper.Config.reliability;
                    if (alpha < config.suggestionThreshold && items.length >= 4) {
                        let bestAlpha = -1, itemToDelete = null;
                        for (const item of items) {
                            const tempItems = items.filter(i => i !== item);
                            const tempK = tempItems.length;
                            let tempSumVar = 0;
                            for (const h of tempItems) { const d = respondents.map(r => Number(r[h])).filter(n => !isNaN(n)); if (d.length > 1) tempSumVar += this.stats.variance(d); }
                            const tempTotalScores = respondents.map(r => tempItems.reduce((s, h) => s + (isNaN(Number(r[h])) ? 0 : Number(r[h])), 0));
                            const tempTotalVar = this.stats.variance(tempTotalScores);
                            const newAlpha = (tempTotalVar === 0) ? 0 : (tempK / (tempK - 1)) * (1 - (tempSumVar / tempTotalVar));
                            if (newAlpha > bestAlpha) { bestAlpha = newAlpha; itemToDelete = item; }
                        }
                        if (bestAlpha > alpha) {
                            suggestion = { itemToDelete, newAlpha: bestAlpha, oldAlpha: alpha };
                        }
                    }
                    results.push({ name: dim, itemCount: items.length, alpha, suggestion });
                }
                return { dimensions, results };
            },
            calculateMeasurementModelReport: function() {
                const dimensions = this._getDimensions();
                if (Object.keys(dimensions).length === 0) return null;
                const allItemHeaders = Object.values(dimensions).flat();
                const { parsedData, existingHeaders } = this._getParsedData(allItemHeaders);
                parsedData.forEach(row => {
                    for (const dim in dimensions) {
                        const items = dimensions[dim].filter(item => existingHeaders.includes(item));
                        if (items.length === 0) continue;
                        let sum = 0, count = 0;
                        for (const item of items) { if (!isNaN(row[item])) { sum += row[item]; count++; } }
                        row[dim] = count > 0 ? sum / count : NaN;
                    }
                });
                const finalResults = {};
                for (const dim in dimensions) {
                    const items = dimensions[dim].filter(item => existingHeaders.includes(item));
                    if (items.length === 0) continue;
                    const proxyScoreArray = parsedData.map(row => row[dim]);
                    const loadings = {};
                    for (const item of items) {
                        const itemArray = parsedData.map(row => row[item]);
                        loadings[item] = this.stats.pearson(itemArray, proxyScoreArray);
                    }
                    const loadingValues = Object.values(loadings).filter(v => !isNaN(v));
                    if(loadingValues.length === 0) continue;
                    const sumOfLoadings = loadingValues.reduce((a, b) => a + b, 0);
                    const sumOfSquaredLoadings = loadingValues.reduce((a, b) => a + b*b, 0);
                    const sumOfErrorVariances = loadingValues.reduce((a, b) => a + (1 - b*b), 0);
                    const cr = (sumOfLoadings ** 2) / ((sumOfLoadings ** 2) + sumOfErrorVariances);
                    const ave = sumOfSquaredLoadings / loadingValues.length;
                    finalResults[dim] = { CR: cr, AVE: ave, Loadings: loadings };
                }
                return finalResults;
            },
            calculateValidityReport: function() {
                const dimensions = this._getDimensions();
                const dimKeys = Object.keys(dimensions);
                if (dimKeys.length < 2) return null;
                const allItemHeaders = Object.values(dimensions).flat();
                const { parsedData, existingHeaders } = this._getParsedData(allItemHeaders);
                for (const dimKey of dimKeys) {
                    dimensions[dimKey] = dimensions[dimKey].filter(item => existingHeaders.includes(item));
                }
                const correlations = {};
                for (let i = 0; i < allItemHeaders.length; i++) {
                    for (let j = i; j < allItemHeaders.length; j++) {
                        const header1 = allItemHeaders[i], header2 = allItemHeaders[j];
                        if (!correlations[header1]) correlations[header1] = {};
                        if (!correlations[header2]) correlations[header2] = {};
                        const seriesA = parsedData.map(row => row[header1]);
                        const seriesB = parsedData.map(row => row[header2]);
                        const corr = this.stats.pearson(seriesA, seriesB);
                        correlations[header1][header2] = correlations[header2][header1] = corr;
                    }
                }
                const htmtData = {};
                for (let i = 0; i < dimKeys.length; i++) {
                    for (let j = i + 1; j < dimKeys.length; j++) {
                        const dim1 = dimKeys[i], dim2 = dimKeys[j];
                        const items1 = dimensions[dim1], items2 = dimensions[dim2];
                        if (items1.length === 0 || items2.length === 0) continue;
                        let heteroSum = 0;
                        items1.forEach(item1 => items2.forEach(item2 => heteroSum += Math.abs(correlations[item1][item2])));
                        const avgHetero = heteroSum / (items1.length * items2.length);
                        let monoSum1 = 0;
                        for (let k = 0; k < items1.length; k++) { for (let l = k + 1; l < items1.length; l++) { monoSum1 += Math.abs(correlations[items1[k]][items1[l]]); } }
                        const avgMono1 = items1.length > 1 ? monoSum1 / (items1.length * (items1.length - 1) / 2) : 1;
                        let monoSum2 = 0;
                        for (let k = 0; k < items2.length; k++) { for (let l = k + 1; l < items2.length; l++) { monoSum2 += Math.abs(correlations[items2[k]][items2[l]]); } }
                        const avgMono2 = items2.length > 1 ? monoSum2 / (items2.length * (items2.length - 1) / 2) : 1;
                        const htmtValue = avgHetero / Math.sqrt(avgMono1 * avgMono2);
                        if (!htmtData[dim1]) htmtData[dim1] = {};
                        htmtData[dim1][dim2] = htmtValue;
                    }
                }
                return { htmtData, dimKeys };
            },
            calculateAbnormalSampleReport: function() {
                const dimensions = this._getDimensions();
                const scaleQuestionHeaders = Object.values(dimensions).flat();
                if (scaleQuestionHeaders.length < 2) return { error: '未找到足够的量表题进行分析。' };

                const allData = Array.from(CredamoAnalysisHelper.Data.processedData.values());
                const config = CredamoAnalysisHelper.Config.abnormalSample;

                let allResponses = [];
                allData.forEach(row => {
                    scaleQuestionHeaders.forEach(header => {
                        const val = parseFloat(row[header]);
                        if (!isNaN(val)) allResponses.push(val);
                    });
                });
                const overallMean = this.stats.mean(allResponses);
                const overallStdDev = allResponses.length > 1 ? Math.sqrt(this.stats.variance(allResponses)) : 0;

                let maxScaleValue = 0;
                for (const header of scaleQuestionHeaders) {
                    for (const row of allData) {
                        const val = parseInt(row[header], 10);
                        if (!isNaN(val) && val > maxScaleValue) { maxScaleValue = val; }
                    }
                }

                const durations = allData.map(row => parseFloat(row['作答总时长'])).filter(t => !isNaN(t) && t > 0);
                const medianDuration = durations.length > 0 ? durations.sort((a,b)=>a-b)[Math.floor(durations.length/2)] : 0;
                const thresholds = {
                    duration: medianDuration / config.durationRatio,
                    scaleType: maxScaleValue > config.scaleTypeThreshold ? 7 : 5,
                    stdDev: maxScaleValue > config.scaleTypeThreshold ? config.stdDevThreshold_7_point : config.stdDevThreshold_5_point,
                    consecutive: Math.floor(Math.min(config.consecutiveThresholdMax, scaleQuestionHeaders.length / 2)),
                    zScore: config.zScoreThreshold
                };

                const abnormalSamples = [];
                CredamoAnalysisHelper.Data.processedData.forEach((row, answerSign) => {
                    const sampleAnswers = scaleQuestionHeaders.map(h => parseFloat(row[h])).filter(n => !isNaN(n));
                    if (sampleAnswers.length < 2) return;

                    const badReasons = [];
                    const neutralReasons = [];
                    let sortPriority = 99, sampleStdDev = Infinity;

                    let maxConsecutive = 0;
                    if (sampleAnswers.length > 1) {
                        let current = 1;
                        for (let i = 1; i < sampleAnswers.length; i++) {
                            if (sampleAnswers[i] === sampleAnswers[i - 1]) { current++; }
                            else { maxConsecutive = Math.max(maxConsecutive, current); current = 1; }
                        }
                        maxConsecutive = Math.max(maxConsecutive, current);
                    }
                    if (maxConsecutive > thresholds.consecutive) { badReasons.push(`连续一致答案(${maxConsecutive}次)`); sortPriority = 1; }

                    const answerTime = parseFloat(row['作答总时长']);
                    if (!isNaN(answerTime) && answerTime < thresholds.duration) { badReasons.push(`时长过短(${answerTime.toFixed(0)}s)`); sortPriority = Math.min(sortPriority, 2); }

                    const variance = this.stats.variance(sampleAnswers);
                    if (variance === 0) {
                        badReasons.push('直线作答');
                        sortPriority = Math.min(sortPriority, 3);
                        sampleStdDev = 0;
                    } else {
                        const stdDev = Math.sqrt(variance);
                        if (stdDev < thresholds.stdDev) {
                            const reasonText = `离散度过低(SD=${stdDev.toFixed(2)})`;
                            if (stdDev <= config.stdDevRedThreshold) {
                                badReasons.push(reasonText);
                            } else {
                                neutralReasons.push(reasonText);
                            }
                            sortPriority = Math.min(sortPriority, 4);
                            sampleStdDev = stdDev;
                        }
                    }

                    // 检查每个潜变量下观察变量的标准差
                    for (const dim in dimensions) {
                        const dimItems = dimensions[dim];
                        if (dimItems.length >= 3) {
                            const dimValues = dimItems.map(item => parseFloat(row[item])).filter(v => !isNaN(v));
                            if (dimValues.length >= 3) {
                                const dimStdDev = Math.sqrt(this.stats.variance(dimValues));
                                if (dimStdDev >= 2.0) {
                                    // 检查是否存在反向编码变量
                                    const hasReverseItems = CredamoAnalysisHelper.Data.csvHeaders.some(header => 
                                        header.startsWith('r_') && dimItems.some(item => header === `r_${item}`)
                                    );
                                    
                                    // 根据标准差大小设置颜色和样式
                                    let stdStyle = 'color: #000;'; // 默认黑色，不加粗
                                    if (dimStdDev > 3.0) {
                                        stdStyle = 'color: #6a0dad; font-weight: bold;'; // 紫色加粗
                                    } else if (dimStdDev > 2.5) {
                                        stdStyle = 'color: #d9534f; font-weight: bold;'; // 红色加粗
                                    }
                                    
                                    const dimNameDisplay = hasReverseItems ? `<span style="color: #d9534f; font-weight: bold;">${dim}</span>` : dim;
                                    const stdDisplay = `<span style="${stdStyle}">${dimStdDev.toFixed(2)}</span>`;
                                    neutralReasons.push(`潜变量${dimNameDisplay}观察变量标准差异常(SD=${stdDisplay})`);
                                    if (badReasons.length === 0) {
                                        sortPriority = Math.min(sortPriority, 6);
                                    }
                                }
                            }
                        }
                    }

                    if (overallStdDev > 0 && sampleAnswers.length > 0) {
                        const sampleMean = this.stats.mean(sampleAnswers);
                        const zScore = (sampleMean - overallMean) / overallStdDev;
                        if (Math.abs(zScore) > thresholds.zScore) {
                            neutralReasons.push(`平均分Z-score异常(|Z|=${Math.abs(zScore).toFixed(2)})`);
                            if (badReasons.length === 0) {
                                sortPriority = Math.min(sortPriority, 5);
                            }
                        }
                    }

                    if (badReasons.length > 0 || neutralReasons.length > 0) {
                        abnormalSamples.push({ id: answerSign, badReasons, neutralReasons, sortPriority, sd: sampleStdDev });
                    }
                });
                abnormalSamples.sort((a, b) => a.sortPriority - b.sortPriority || a.sd - b.sd);
                return { abnormalSamples, thresholds };
            }
        },

        UI: {
            // ===================================================================
            // 【V8.0 新增】将目标域名提取到这里，方便修改
            // ===================================================================
            //TARGET_DOMAIN: 'http://localhost:3000', // <-- 用于本地开发
            //TARGET_DOMAIN: 'https://datapls.netlify.app', // <-- 备用域名
            TARGET_DOMAIN: 'https://datapls.fun',
            // ===================================================================

            elements: {},
            isMinimized: false,
            isDisclaimerClosed: false,
            styleSheet: `
                .cah-button-container { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 5px; }
                .cah-button { flex-basis: 32%; padding: 8px; font-size: 12px; color: white !important; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 5px; box-sizing: border-box; transition: opacity 0.2s; }
                .cah-button.full-width { flex-basis: 100%; margin-top: 5px; }
                .cah-button:hover { opacity: 0.85; }
                .cah-toggle-link { color: #007bff; text-decoration: none; font-size: 12px; font-weight: bold; }
                .cah-toggle-link:hover { text-decoration: underline; }
                .cah-copy-link { color: #007bff; text-decoration: none; font-size: 11px; margin-left: 8px; cursor: pointer; font-weight: bold; }
                .cah-copy-link:hover { text-decoration: underline; }
                .cah-table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
                .cah-table th, .cah-table td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: middle; }
                .cah-table th { background-color: #f2f2f2; font-weight: bold; }
                .cah-table tbody tr:nth-child(even) { background-color: #f9f9f9; }
                .cah-table td { text-align: center; }
                .cah-table td:first-child { text-align: left; font-weight: bold; font-family: monospace; }
                .cah-htmt-bad { color: #d9534f; font-weight: bold; }
                .cah-htmt-warning { color: #f0ad4e; font-weight: bold; }
                .cah-summary-box { background-color: #f8f9fa; border: 1px solid #dee2e6; padding: 12px; border-radius: 5px; margin-bottom: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
                .cah-summary-box h4 { margin:0 0 8px 0; color: #333; }
                .cah-summary-box ul { font-size: 13px; margin: 0 0 0 20px; padding:0; color: #555; }
            `,
            create: function() {
                this.elements.panel = this._createStyledElement('div', `position: fixed; bottom: 10px; right: 10px; width: 420px; height: 250px; min-width: 300px; min-height: 200px; overflow: hidden; background-color: rgba(0, 0, 0, 0.9); color: white; font-size: 14px; padding: 10px 10px 130px 10px; border-radius: 8px; z-index: 999999; font-family: monospace; border: 2px solid #35ff95; display: flex; flex-direction: column;`);
                this.elements.panel.dataset.originalHeight = '250px';
                const titleBar = this._createStyledElement('div', `position: relative; display: flex; justify-content: space-between; align-items: center; color: #35ff95; font-weight: bold; margin-bottom: 10px; border-bottom: 1px solid #35ff95; padding-bottom: 5px; cursor: move; flex-shrink: 0;`);
                this.elements.titleText = this._createStyledElement('span', '', '📤 数据与模型分析助手');
                this.elements.toggleButton = this._createStyledElement('button', `background: transparent; border: none; color: #35ff95; font-size: 20px; cursor: pointer; padding: 0 5px;`, '—');
                const controlsContainer = this._createStyledElement('div');
                controlsContainer.appendChild(this.elements.toggleButton);
                titleBar.append(this.elements.titleText, controlsContainer);
                this.elements.contentArea = this._createStyledElement('div', `flex-grow: 1; overflow-y: auto; height: 100%;`, '📡 等待POST请求...');
                this.elements.resizeHandle = this._createStyledElement('div', `position: absolute; right: 0; bottom: 0; width: 15px; height: 15px; cursor: nwse-resize; z-index: 1000001;`);
                const buttonContainer = this._createStyledElement('div', `position: absolute; bottom: 5px; left: 10px; right: 10px;`);
                buttonContainer.className = 'cah-button-container';
                this.elements.exportCsvButton = this._createStyledElement('button', `background-color: #4CAF50;`, '📊 导出Excel');
                this.elements.cronbachButton = this._createStyledElement('button', `background-color: #007bff;`, '🔬 信度分析');
                this.elements.measurementModelButton = this._createStyledElement('button', `background-color: #6f42c1;`, '🛠️ 测量模型');
                this.elements.validityButton = this._createStyledElement('button', `background-color: #0056b3;`, '📈 效度分析');
                this.elements.abnormalSampleButton = this._createStyledElement('button', `background-color: #ffc107; `, '🚨 异常检测');
                this.elements.clearButton = this._createStyledElement('button', `background-color: #f44336;`, '🗑️ 清空');
                this.elements.sendToPlsButton = this._createStyledElement('button', `background-color: #28a745;`, '🚀 发送到DataPLS分析');

                Object.values(this.elements).forEach(el => { if(el.tagName === 'BUTTON') el.classList.add('cah-button'); });

                this.elements.sendToPlsButton.classList.add('full-width');

                buttonContainer.append(this.elements.exportCsvButton, this.elements.cronbachButton, this.elements.measurementModelButton, this.elements.validityButton, this.elements.abnormalSampleButton, this.elements.clearButton, this.elements.sendToPlsButton);
                this.elements.panel.append(titleBar, this.elements.contentArea, buttonContainer, this.elements.resizeHandle);
                this.elements.reliabilityModal = this._createModal('克隆巴赫(Cronbach\'s α)信度分析结果');
                this.elements.measurementModelModal = this._createModal('测量模型评估 (AVE/CR/Loadings)');
                this.elements.validityModal = this._createModal('HTMT 区分效度分析结果', '700px');
                this.elements.abnormalSampleModal = this._createModal('异常样本检测报告', '700px');
            },
            _injectStyles: function() {
                const styleEl = document.createElement('style');
                styleEl.textContent = this.styleSheet;
                document.head.appendChild(styleEl);
            },
            bindEvents: function() {
                this.elements.toggleButton.addEventListener('click', () => this.toggleMinimize());
                this.elements.clearButton.addEventListener('click', () => this.handleClear());
                this.elements.exportCsvButton.addEventListener('click', () => this.handleExportCsv());
                this.elements.cronbachButton.addEventListener('click', () => this.handleReliabilityAnalysis());
                this.elements.measurementModelButton.addEventListener('click', () => this.handleMeasurementModelAnalysis());
                this.elements.validityButton.addEventListener('click', () => this.handleValidityAnalysis());
                this.elements.abnormalSampleButton.addEventListener('click', () => this.handleAbnormalSampleAnalysis());
                this.elements.sendToPlsButton.addEventListener('click', () => this.handleSendToDataPLS());

                this._makeDraggable(this.elements.panel, this.elements.panel.querySelector('div'));
                this._makeResizable(this.elements.panel, this.elements.resizeHandle);
                Object.values(this.elements).forEach(el => {
                    if(el.modal) this._makeDraggable(el.modal, el.modal.querySelector('div'));
                });
            },
            inject: function() {
                try {
                    document.body.append( this.elements.panel, this.elements.reliabilityModal.modal, this.elements.measurementModelModal.modal, this.elements.validityModal.modal, this.elements.abnormalSampleModal.modal );
                    console.log('Credamo分析助手: UI 注入成功!');
                } catch (e) {
                    console.error('Credamo分析助手: UI 注入失败!', e);
                    alert('Credamo分析助手: 错误！脚本界面加载失败。');
                }
            },
            updatePanelDisplay: function() {
                const data = CredamoAnalysisHelper.Data;
                this.elements.contentArea.innerHTML = `✅ 已捕获 <strong>${data.processedData.size}</strong> 条(待审核、已采纳）。<br>⏭️ 已跳过 <strong>${data.duplicateCount}</strong> 条。<br><strong style="color: #ff9800;">🚫 已过滤 ${data.filteredByStatusCount} 条非目标状态样本。</strong><br><br>👉 请继续翻页...`;
                this.elements.titleText.innerText = `📤 数据助手 (${data.processedData.size}条)`;
            },
            showError: function(message) {
                 this.elements.contentArea.innerHTML = `<strong style="color:red;">脚本运行出错!</strong><br>详情请查看控制台。<br><br><strong>错误摘要:</strong><br><span style="font-size:12px;">${message}</span>`;
            },
            handleClear: function() {
                CredamoAnalysisHelper.Data.clear();
                this.updatePanelDisplay();
                this.elements.titleText.innerText = '📤 数据与模型分析助手';
                this.elements.contentArea.innerHTML = '📡 记录已清空，等待POST请求...';
                this._flashButton(this.elements.clearButton, '✅ 已清空', '🗑️ 清空');
            },
            _generateCsvContent: function() {
                const data = CredamoAnalysisHelper.Data;
                if (data.processedData.size === 0) {
                    alert('没有可处理的数据！');
                    return null;
                }
                const escapeCsvCell = (cell) => {
                    const cellString = (cell === undefined || cell === null) ? '' : String(cell);
                    if (/[",\n]/.test(cellString)) {
                        return `"${cellString.replace(/"/g, '""')}"`;
                    }
                    return cellString;
                };
                const csvHeaderRow = data.csvHeaders.map(escapeCsvCell).join(',');
                const csvRows = Array.from(data.processedData.values()).map(row =>
                    data.csvHeaders.map(header => escapeCsvCell(row[header])).join(',')
                );
                return '\uFEFF' + [csvHeaderRow, ...csvRows].join('\n');
            },
            _generateScaleCsvContent: function() {
                const data = CredamoAnalysisHelper.Data;
                if (data.processedData.size === 0) {
                    alert('没有可处理的数据！');
                    return null;
                }
                const scalePattern = /^([a-zA-Z_]+[a-zA-Z]?)(?:\d+|_\d+)$/;
                const singleQPattern = /^Q\d+$/;
                const scaleHeaders = data.csvHeaders.filter(header =>
                    scalePattern.test(header) && !singleQPattern.test(header)
                );
                if (scaleHeaders.length === 0) {
                    alert('未找到量表题项！请确认题项命名符合 "字母+数字" 格式（如 A1、B2）。');
                    return null;
                }
                const escapeCsvCell = (cell) => {
                    const cellString = (cell === undefined || cell === null) ? '' : String(cell);
                    if (/[",\n]/.test(cellString)) {
                        return `"${cellString.replace(/"/g, '""')}"`;
                    }
                    return cellString;
                };
                const csvHeaderRow = scaleHeaders.join(',');
                const csvRows = Array.from(data.processedData.values()).map(row =>
                    scaleHeaders.map(header => escapeCsvCell(row[header])).join(',')
                );
                return '\uFEFF' + [csvHeaderRow, ...csvRows].join('\n');
            },
            handleExportCsv: function() {
                const csvContent = this._generateCsvContent();
                if (!csvContent) return;

                const data = CredamoAnalysisHelper.Data;
                const firstRecord = data.processedData.values().next().value;
                let keyword = firstRecord && firstRecord['问卷发布名称'] ? firstRecord['问卷发布名称'].match(/[a-zA-Z0-9]+/g)?.[0] || '数据' : '数据';
                const dateString = new Date().toISOString().slice(0, 10);
                const filename = `${keyword}-${data.processedData.size}条-${dateString}.csv`;

                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = filename; a.click();
                URL.revokeObjectURL(url);
                this._flashButton(this.elements.exportCsvButton, '✅ 导出成功!', '📊 导出Excel');
            },
            handleSendToDataPLS: function() {
                const csvContent = this._generateScaleCsvContent();
                if (!csvContent) return;

                const button = this.elements.sendToPlsButton;
                this._flashButton(button, '🚀 正在发送...', button.textContent);

                const targetWindow = window.open(this.TARGET_DOMAIN, '_blank');

                if (!targetWindow) {
                    alert('发送失败！请允许此网站的弹出式窗口。');
                    this._flashButton(button, '❌ 发送失败', '🚀 发送到DataPLS分析');
                    return;
                }

                let intervalId = null;
                let isSuccess = false;

                const messageListener = (event) => {
                    if (event.origin === this.TARGET_DOMAIN && event.data === 'CSV_RECEIVED_SUCCESS') {
                        isSuccess = true;
                        console.log('油猴脚本：收到DataPLS的回执，停止发送。');
                        if (intervalId) {
                            clearInterval(intervalId);
                        }
                        this._flashButton(button, '✅ 发送成功!', '🚀 发送到DataPLS分析');
                        window.removeEventListener('message', messageListener);
                    }
                };

                window.addEventListener('message', messageListener);

                const sendData = () => {
                    if (targetWindow.closed) {
                        clearInterval(intervalId);
                        window.removeEventListener('message', messageListener);
                        this._flashButton(button, '❌ 窗口已关闭', '🚀 发送到DataPLS分析');
                        return;
                    }
                    console.log(`油猴脚本：正在尝试向 ${this.TARGET_DOMAIN} 发送数据...`);
                    targetWindow.postMessage(csvContent, this.TARGET_DOMAIN);
                };

                sendData();
                intervalId = setInterval(sendData, 1000);

                setTimeout(() => {
                    if (intervalId) {
                        clearInterval(intervalId);
                    }
                    window.removeEventListener('message', messageListener);

                    if (!isSuccess) {
                        alert('发送数据超时，请确保目标网站已打开并重试。');
                        this._flashButton(button, '❌ 发送超时', '🚀 发送到DataPLS分析');
                    }
                }, 15000);
            },
            handleReliabilityAnalysis: function() {
                if (CredamoAnalysisHelper.Data.processedData.size < 2) return alert('数据不足');
                const { modal, modalBody } = this.elements.reliabilityModal;
                this._showModal(modal, modalBody, '正在计算...');
                const report = CredamoAnalysisHelper.Analysis.calculateCronbachReport();
                const config = CredamoAnalysisHelper.Config.reliability;
                let html = '';
                if(report.results.length === 0) {
                    html = '未找到可供分析的维度 (题项命名需符合 "字母+数字" 格式)。';
                } else {
                    report.results.forEach(res => {
                        let color;
                        if (res.alpha >= config.alphaThreshold) {
                            color = '#28a745';
                        } else if (res.alpha >= 0.6) {
                            color = '#000000';
                        } else {
                            color = '#d9534f';
                        }

                        html += `<div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #eee; font-family: -apple-system, sans-serif;">
                                     <span style="color: ${color};">维度 [${res.name}] (${res.itemCount}项):  α = ${res.alpha.toFixed(3)}</span>`;
                        if (res.suggestion) {
                            const increase = ((res.suggestion.newAlpha - res.suggestion.oldAlpha) / res.suggestion.oldAlpha) * 100;
                            html += `<br><span style="color: #0056b3; font-size: 0.9em;">&nbsp;&nbsp;↳ 提示: 若删除题项 "${res.suggestion.itemToDelete}", α 可提升至 ${res.suggestion.newAlpha.toFixed(3)} (${increase > 0 ? `提升 ${increase.toFixed(2)}%` : ''})</span>`;
                        }
                        html += `</div>`;
                    });
                }
                modalBody.innerHTML = html;
            },
            handleMeasurementModelAnalysis: function() {
                if (CredamoAnalysisHelper.Data.processedData.size < 2) return alert('数据不足');
                const { modal, modalBody } = this.elements.measurementModelModal;
                this._showModal(modal, modalBody, '正在计算...');
                setTimeout(() => {
                    const results = CredamoAnalysisHelper.Analysis.calculateMeasurementModelReport();
                    if (!results || Object.keys(results).length === 0) {
                        modalBody.innerHTML = '未找到可供分析的维度。'; return;
                    }
                    let html = '';
                    if(!this.isDisclaimerClosed) {
                         html += this._getDisclaimerHtml();
                    }
                    const config = CredamoAnalysisHelper.Config.measurementModel;
                    for(const dim in results){
                        const res = results[dim];
                        const loadingsTableId = `loadings-table-${dim}`;
                        const cr_color = res.CR >= config.crThreshold ? '#28a745' : '#d9534f';
                        const ave_color = res.AVE >= config.aveThreshold ? '#28a745' : '#d9534f';
                        html += `<div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #eee; font-family: -apple-system, sans-serif;">
                                     <strong style="font-size: 16px;">构念: ${dim}</strong><br>
                                     <span>组合信度 (CR): <strong style="color: ${cr_color};">${res.CR.toFixed(3)}</strong> (标准 > ${config.crThreshold})</span><br>
                                     <span>平均变异提取量 (AVE): <strong style="color: ${ave_color};">${res.AVE.toFixed(3)}</strong> (标准 > ${config.aveThreshold})</span><br>
                                     <a href="#" class="cah-toggle-link" data-table-id="${loadingsTableId}">[+] 显示/隐藏详细载荷</a>
                                     <div id="${loadingsTableId}" style="display: none;">
                                         <table class="cah-table">
                                             <thead><tr><th>题项</th><th>外部载荷 (近似值)</th><th>状态 (标准 > ${config.loadingThreshold})</th></tr></thead><tbody>`;
                        for(const item in res.Loadings){
                            const loading = res.Loadings[item];
                            const l_color = loading >= config.loadingThreshold ? '#000' : '#d9534f';
                            html += `<tr><td>${item}</td><td style="color:${l_color}">${loading.toFixed(3)}</td><td style="color:${l_color}">${loading >= config.loadingThreshold ? '✅' : '❌'}</td></tr>`;
                        }
                        html += `</tbody></table></div></div>`;
                    }
                    modalBody.innerHTML = html;
                    modalBody.querySelectorAll('.cah-toggle-link').forEach(link => {
                        link.onclick = (e) => { e.preventDefault(); const table = document.getElementById(e.target.dataset.tableId); table.style.display = table.style.display === 'none' ? 'block' : 'none'; };
                    });
                    const closeBtn = modalBody.querySelector('#close-disclaimer');
                    if(closeBtn) {
                        closeBtn.onclick = () => { modalBody.querySelector('#disclaimer-box').style.display = 'none'; this.isDisclaimerClosed = true; };
                    }
                }, 50);
            },
            handleValidityAnalysis: function() {
                if (CredamoAnalysisHelper.Data.processedData.size < 2) return alert('数据不足');
                const { modal, modalBody } = this.elements.validityModal;
                this._showModal(modal, modalBody, '正在计算...');
                const report = CredamoAnalysisHelper.Analysis.calculateValidityReport();
                if (!report) { modalBody.innerHTML = '至少需要两个维度才能进行HTMT分析。'; return; }
                const { htmtData, dimKeys } = report;
                const config = CredamoAnalysisHelper.Config.validity;
                let html = `<div style="font-family: -apple-system, sans-serif;"><p>HTMT值通常应低于 ${config.htmtThresholdStrict} (警告) 或 ${config.htmtThresholdLoose} (严重) 以表明良好的区分效度。</p>
                                <table class="cah-table"><thead><tr><th></th>${dimKeys.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>`;
                for (let i = 0; i < dimKeys.length; i++) {
                    html += `<tr><td>${dimKeys[i]}</td>`;
                    for (let j = 0; j < dimKeys.length; j++) {
                        let cellValue = '';
                        if (i > j) {
                            const htmt = htmtData[dimKeys[j]]?.[dimKeys[i]];
                            if(htmt !== undefined) {
                                let colorClass = '';
                                if (htmt >= config.htmtThresholdLoose) colorClass = 'cah-htmt-bad';
                                else if (htmt >= config.htmtThresholdStrict) colorClass = 'cah-htmt-warning';
                                cellValue = `<span class="${colorClass}">${htmt.toFixed(3)}</span>`;
                            }
                        }
                        html += `<td>${cellValue}</td>`;
                    }
                    html += `</tr>`;
                }
                html += '</tbody></table></div>';
                modalBody.innerHTML = html;
            },
            handleAbnormalSampleAnalysis: function() {
                if (CredamoAnalysisHelper.Data.processedData.size < 3) return alert('数据不足');
                const { modal, modalBody } = this.elements.abnormalSampleModal;
                this._showModal(modal, modalBody, '正在计算...');
                const report = CredamoAnalysisHelper.Analysis.calculateAbnormalSampleReport();
                if(report.error){ modalBody.innerHTML = report.error; return; }
                const { abnormalSamples, thresholds } = report;
                let html = `<div class="cah-summary-box">
                                <h4>检测标准概要:</h4>
                                <ul>
                                    <li><b>时长阈值:</b> < ${thresholds.duration.toFixed(1)} 秒 （中位数的1/3）</li>
                                    <li><b>离散度阈值 (SD):</b> < ${thresholds.stdDev} (基于${thresholds.scaleType}点量表)，≤0.4标红</li>
                                    <li><b>连续答案阈值:</b> > ${thresholds.consecutive} 次</li>
                                    <li><b>平均分 Z-score 绝对值:</b> > ${thresholds.zScore}</li>
                                    <li><b>潜变量标准差异常:</b> 每个潜变量下观察变量标准差 ≥ 2.0 (检测作答不一致性)</li>
                                </ul>
                            </div>`;
                if(abnormalSamples.length > 0) {
                    html += `<h4 style="font-family: -apple-system, sans-serif;">共检测到 ${abnormalSamples.length} 个潜在异常样本:</h4>
                                 <table class="cah-table">
                                     <thead><tr><th>作答ID</th><th>异常原因</th></tr></thead><tbody>`;
                    abnormalSamples.forEach(s => {
                        let reasonsHtml = '';
                        if (s.badReasons && s.badReasons.length > 0) {
                            reasonsHtml += `<strong class="cah-htmt-bad">${s.badReasons.join('; ')}</strong>`;
                        }
                        if (s.neutralReasons && s.neutralReasons.length > 0) {
                            if (reasonsHtml.length > 0) {
                                reasonsHtml += '; ';
                            }
                            reasonsHtml += `<span>${s.neutralReasons.join('; ')}</span>`;
                        }
                        html += `<tr>
                                     <td>${s.id} <a href="#" class="cah-copy-link" data-id="${s.id}">复制</a></td>
                                     <td>${reasonsHtml}</td>
                                   </tr>`;
                    });
                    html += `</tbody></table>`;
                } else {
                    html += '<p style="color: #28a745; font-weight: bold; font-size: 16px; font-family: -apple-system, sans-serif;">✅ 未检测到符合条件的异常样本。</p>';
                }
                modalBody.innerHTML = html;

                modalBody.querySelectorAll('.cah-copy-link').forEach(link => {
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        const idToCopy = e.target.getAttribute('data-id');
                        navigator.clipboard.writeText(idToCopy).then(() => {
                            e.target.textContent = '已复制!';
                            setTimeout(() => { e.target.textContent = '复制'; }, 1500);
                        }).catch(err => {
                            console.error('复制失败: ', err);
                            alert('复制失败，请检查浏览器权限设置。');
                        });
                    });
                });
            },
            _createStyledElement: function(tag, style, text) {
                const el = document.createElement(tag);
                if (style) el.style.cssText = style;
                if (text) el.innerText = text;
                return el;
            },
            _createModal: function(title, width = '600px') {
                const modal = this._createStyledElement('div', `display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: ${width}; max-height: 80vh; background-color: #fff; border: 1px solid #ccc; border-radius: 8px; z-index: 1000000; box-shadow: 0 5px 15px rgba(0,0,0,0.3);`);
                const header = this._createStyledElement('div', `display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background-color: #f0f0f0; color: #333; border-bottom: 1px solid #ddd; border-radius: 8px 8px 0 0; cursor: move; font-weight: bold;`);
                header.innerHTML = `<span>${title}</span><span style="font-size:22px;cursor:pointer;color:#888;">×</span>`;
                header.lastChild.onclick = () => modal.style.display = 'none';
                const modalBody = this._createStyledElement('div', `padding: 20px; overflow-y: auto; max-height: calc(80vh - 50px); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.7; color: #333 !important;`);
                modal.append(header, modalBody);
                return { modal, modalBody };
            },
            _showModal: function(modal, body, loadingText = '...'){
                body.innerHTML = loadingText;
                modal.style.display = 'block';
            },
            toggleMinimize: function() {
                this.isMinimized = !this.isMinimized;
                const { panel, contentArea, toggleButton, resizeHandle } = this.elements;
                const buttonContainer = panel.querySelector('.cah-button-container');
                if (this.isMinimized) {
                    panel.style.height = '42px';
                    panel.style.minHeight = '42px';
                    contentArea.style.display = 'none';
                    buttonContainer.style.display = 'none';
                    resizeHandle.style.display = 'none';
                    toggleButton.innerText = '🔳';
                    toggleButton.title = '最大化';
                } else {
                    panel.style.height = panel.dataset.originalHeight;
                    panel.style.minHeight = '200px';
                    contentArea.style.display = 'block';
                    buttonContainer.style.display = 'flex';
                    resizeHandle.style.display = 'block';
                    toggleButton.innerText = '—';
                    toggleButton.title = '最小化';
                }
            },
            _flashButton: function(button, tempText, originalText) {
                button.innerText = tempText;
                setTimeout(() => button.innerText = originalText, 1500);
            },
            _getDisclaimerHtml: function(){
                return `<div id="disclaimer-box" style="position: relative; background-color: #e9ecef; border: 1px solid #ced4da; color: #495057; padding: 12px; border-radius: 4px; margin-bottom: 20px; font-size: 13px; line-height: 1.6;">
                          <span id="close-disclaimer" style="position: absolute; top: 5px; right: 10px; font-size: 20px; cursor: pointer; color: #6c757d;">&times;</span>
                          <strong>重要提示:</strong>
                          <ul style="margin: 8px 0 0 20px; padding: 0;">
                              <li>此结果通过<b>代理法</b>估算，用于快速诊断。</li>
                              <li><b>外部载荷</b>与SmartPLS结果差异可能较大，主要用于识别低载荷题项。</li>
                              <li>CR与AVE结果与SmartPLS近似，可作可靠参考。</li>
                              <li style="font-weight: bold; color: #c82333;">最终发表请务必以SmartPLS为准。</li>
                          </ul>
                        </div>`;
            },
            _makeDraggable: function(modal, handle) {
                let isDragging = false, offset = { x: 0, y: 0 };
                handle.addEventListener('mousedown', (e) => {
                    if (e.target.tagName === 'SPAN' || e.target.tagName === 'BUTTON') return;
                    isDragging = true;
                    offset = { x: e.clientX - modal.offsetLeft, y: e.clientY - modal.offsetTop };
                    e.preventDefault();
                });
                document.addEventListener('mousemove', (e) => {
                    if (isDragging) {
                        modal.style.left = (e.clientX - offset.x) + 'px';
                        modal.style.top = (e.clientY - offset.y) + 'px';
                    }
                });
                document.addEventListener('mouseup', () => isDragging = false);
            },
            _makeResizable: function(panel, handle) {
                let isResizing = false;
                handle.addEventListener('mousedown', (e) => {
                    e.preventDefault(); isResizing = true;
                    const start = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
                    const doResize = (moveEvent) => {
                        if (isResizing) {
                            panel.style.width = (start.w + moveEvent.clientX - start.x) + 'px';
                            panel.style.height = (start.h + moveEvent.clientY - start.y) + 'px';
                        }
                    };
                    const stopResize = () => {
                        isResizing = false;
                        if (!this.isMinimized) panel.dataset.originalHeight = panel.style.height;
                        window.removeEventListener('mousemove', doResize);
                        window.removeEventListener('mouseup', stopResize);
                    };
                    window.addEventListener('mousemove', doResize);
                    window.addEventListener('mouseup', stopResize);
                });
            }
        },

        init: function() {
            // 【V8.0 修复】使用 MutationObserver 来确保UI能够稳定注入
            const observer = new MutationObserver((mutations, obs) => {
                if (document.body) {
                    console.log('Credamo分析助手: 检测到 <body>，开始注入UI...');
                    this.UI._injectStyles();
                    this.UI.create();
                    this.UI.bindEvents();
                    this.UI.inject();
                    obs.disconnect(); // 注入成功后停止观察，避免重复执行
                }
            });
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });

            // 拦截网络请求的逻辑保持不变
            const self = this;
            const originalFetch = window.fetch;
            window.fetch = async function(...args) {
                const response = await originalFetch(...args);
                if (args[0] && typeof args[0] === 'string' && args[0].includes('survey/row/list')) {
                    response.clone().text().then(text => self.Data.processResponse(text));
                }
                return response;
            };
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                if (method.toUpperCase() === 'POST') this._isPostRequest = true;
                originalOpen.apply(this, arguments);
            };
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function() {
                if (this._isPostRequest) {
                    this.addEventListener('load', () => self.Data.processResponse(this.responseText));
                }
                originalSend.apply(this, arguments);
            };

            console.log("Credamo分析助手 V8.0 (注入修复 & DataPLS联动版) 已加载。");
        }
    };

    CredamoAnalysisHelper.init();

})();