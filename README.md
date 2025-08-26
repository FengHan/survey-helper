# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述
https://greasyfork.org/zh-CN/scripts/544184
这是一个用于问卷数据分析的油猴脚本(Tampermonkey userscript)。脚本在`https://www.xxxxx.com/survey.html*`页面上运行，为问卷回收数据提供统计分析功能。

## 代码架构

### 单文件结构
- `survey_helper.js` - 包含所有功能的完整用户脚本

### 核心组件

**CredamoAnalysisHelper 对象结构:**
- `Config` - 信度、效度和测量模型的配置阈值
- `Data` - 数据处理和存储（拦截网络请求，处理JSON响应）
- `Analysis` - 统计分析函数（克隆巴赫α系数、测量模型、HTMT效度、异常样本检测）
- `UI` - 用户界面管理（浮动面板、模态框、导出功能）

### 主要功能

**数据拦截:**
- 拦截发送到`survey/row/list`端点的POST请求
- 处理包含问卷数据的JSON响应
- 按渠道类型和状态过滤样本
- 将处理后的数据存储在Map结构中

**统计分析:**
- 使用克隆巴赫α系数进行信度分析
- 测量模型评估（CR、AVE、因子载荷）
- 使用HTMT比率进行区分效度检验
- 异常样本检测（回答模式、时长、方差）

**数据导出:**
- 带UTF-8 BOM编码的CSV导出
- 通过postMessage API与外部DataPLS分析平台集成

### UI组件

**主面板:**
- 可拖拽和调整大小的浮动界面
- 实时数据捕获计数器
- 分析按钮和导出功能

**分析模态框:**
- 信度分析结果及改进建议
- 测量模型评估及详细载荷
- 效度分析及HTMT矩阵可视化
- 异常样本检测及过滤标准

## 开发说明

### 配置管理
统计阈值集中在`CredamoAnalysisHelper.Config`中：
- 信度阈值（克隆巴赫α）
- 
- 测量模型标准（CR、AVE、载荷）
- 效度基准（HTMT）
- 异常样本检测参数

### 数据处理流程
1. 网络请求拦截（fetch/XMLHttpRequest）
2. JSON响应解析和验证
3. 样本过滤（渠道类型、状态）
4. 数据结构转换用于分析
5. 实时UI更新

### 外部集成
脚本通过以下方式与DataPLS平台集成：
- 打开目标域名窗口
- PostMessage通信进行数据传输
- 超时处理和成功确认

### 浏览器兼容性
- 使用现代JavaScript特性（Map、Set、箭头函数）
- 依赖用户脚本API（@match、@grant）
- 实现剪贴板操作的降级处理

## 安全考虑

此用户脚本：
- 仅匹配特定的Credamo问卷URL
- 不需要提升权限（@grant none）
- 处理问卷响应数据进行统计分析
- 以标准CSV格式导出数据
- 只与指定的DataPLS域名通信

代码设计用于问卷数据质量的防御性分析和统计验证。