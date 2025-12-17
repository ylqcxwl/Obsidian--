const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, Modal, TFile, TFolder } = require('obsidian');

const DEFAULT_EXCLUDES = [
    '.git',
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    'node_modules'
];

class GithubSyncPro extends Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new GithubSyncSettingTab(this.app, this));
        this.setupAutoSync();
        this.lastEditTime = Date.now();
        this.registerEvent(this.app.vault.on('modify', () => { this.lastEditTime = Date.now(); }));
        console.log('GitHub Sync Pro: 全同步版本已加载');
    }

    async loadSettings() {
        this.settings = Object.assign({
            token: '',
            repo: '',
            branch: 'main',
            syncInterval: 0,
            autoSyncAfterEdit: 0,
            excludedRules: [...DEFAULT_EXCLUDES],
            logs: [],
            isTokenLocked: false
        }, await this.loadData());
    }

    async saveSettings() { await this.saveData(this.settings); }

    addLog(message) {
        const time = new Date().toLocaleTimeString();
        const fullMsg = `[${time}] ${message}`;
        this.settings.logs.unshift(fullMsg);
        if (this.settings.logs.length > 10) this.settings.logs.pop();
        this.saveSettings();
        const settingTab = this.app.setting.lastTab;
        if (settingTab instanceof GithubSyncSettingTab) settingTab.display();
    }

    setupAutoSync() {
        if (this.settings.syncInterval > 0) {
            this.registerInterval(window.setInterval(() => this.sync('merge'), this.settings.syncInterval * 1000));
        }
        this.registerInterval(window.setInterval(() => {
            if (this.settings.autoSyncAfterEdit > 0) {
                const idle = (Date.now() - this.lastEditTime) / 1000;
                if (idle >= this.settings.autoSyncAfterEdit && idle < this.settings.autoSyncAfterEdit + 6) {
                    this.sync('merge');
                }
            }
        }, 5000));
    }

    // --- 核心修改：递归获取所有文件（包含隐藏文件） ---
    async getAllFilesRecursively(path = "") {
        const files = [];
        const res = await this.app.vault.adapter.list(path);
        
        // 处理文件
        for (const filePath of res.files) {
            if (!this.isExcluded(filePath)) {
                files.push(filePath);
            }
        }
        // 处理文件夹
        for (const dirPath of res.folders) {
            if (!this.isExcluded(dirPath)) {
                const subFiles = await this.getAllFilesRecursively(dirPath);
                files.push(...subFiles);
            }
        }
        return files;
    }

    async apiRequest(endpoint, method = 'GET', body = null) {
        const url = `https://api.github.com${endpoint}`;
        const options = {
            url,
            method,
            headers: {
                'Authorization': `token ${this.settings.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        };
        if (body) options.body = JSON.stringify(body);
        try {
            return await requestUrl(options);
        } catch (e) {
            throw new Error(e.status ? `HTTP ${e.status}: ${JSON.stringify(e.json || e.text)}` : e.message);
        }
    }

    async sync(mode) {
        if (!this.settings.token || !this.settings.repo) {
            new Notice("请检查插件配置");
            return;
        }
        this.addLog(`>>> 启动全同步 [模式: ${mode}]`);
        try {
            const treeUrl = `/repos/${this.settings.repo}/git/trees/${this.settings.branch}?recursive=1&t=${Date.now()}`;
            const treeRes = await this.apiRequest(treeUrl);
            const remoteFiles = (treeRes.json.tree || []).filter(i => i.type === 'blob');
            
            // 获取本地所有文件（包括 .obsidian）
            const localFilePaths = await this.getAllFilesRecursively("");

            if (mode === 'local_to_remote') {
                await this.executePush(localFilePaths, remoteFiles);
            } else if (mode === 'remote_to_local') {
                await this.executePull(remoteFiles);
            } else {
                await this.executeMerge(localFilePaths, remoteFiles);
            }
            this.addLog("同步任务完成");
            new Notice("同步完成");
        } catch (err) {
            this.addLog(`错误: ${err.message}`);
        }
    }

    isExcluded(path) {
        return this.settings.excludedRules.some(rule => {
            const regex = new RegExp('^' + rule.replace(/\*/g, '.*') + '$');
            return regex.test(path) || path.startsWith(rule + "/") || path === rule;
        });
    }

    async executePush(localPaths, remotes) {
        this.addLog("推送本地数据 (含配置)...");
        for (const path of localPaths) {
            const content = await this.app.vault.adapter.readBinary(path);
            const remoteMatch = remotes.find(r => r.path === path);
            
            try {
                const base64 = this.arrayBufferToBase64(content);
                await this.apiRequest(`/repos/${this.settings.repo}/contents/${encodeURIComponent(path)}`, 'PUT', {
                    message: `Sync: ${path}`,
                    content: base64,
                    sha: remoteMatch ? remoteMatch.sha : undefined,
                    branch: this.settings.branch
                });
                this.addLog(`上传: ${path}`);
            } catch (e) {
                this.addLog(`上传失败 [${path}]: ${e.message}`);
            }
        }
        // 删除远端多余文件
        const toDelete = remotes.filter(r => !localPaths.includes(r.path) && !this.isExcluded(r.path));
        for (const rFile of toDelete) {
            try {
                await this.apiRequest(`/repos/${this.settings.repo}/contents/${encodeURIComponent(rFile.path)}`, 'DELETE', {
                    message: `Delete: ${rFile.path}`,
                    sha: rFile.sha,
                    branch: this.settings.branch
                });
                this.addLog(`删除远端: ${rFile.path}`);
            } catch (e) {
                this.addLog(`删除失败: ${rFile.path}`);
            }
        }
    }

    async executePull(remotes) {
        this.addLog("拉取远端数据...");
        for (const rFile of remotes) {
            if (this.isExcluded(rFile.path)) continue;
            await this.downloadFile(rFile.path);
        }
    }

    async executeMerge(localPaths, remotes) {
        // 增量上传
        for (const path of localPaths) {
            const rMatch = remotes.find(r => r.path === path);
            if (!rMatch) {
                const content = await this.app.vault.adapter.readBinary(path);
                await this.uploadFile(path, content, null);
            }
        }
        // 增量下载
        for (const rFile of remotes) {
            if (this.isExcluded(rFile.path)) continue;
            if (!localPaths.includes(rFile.path)) {
                await this.downloadFile(rFile.path);
            }
        }
    }

    async uploadFile(path, content, sha) {
        const base64 = this.arrayBufferToBase64(content);
        await this.apiRequest(`/repos/${this.settings.repo}/contents/${encodeURIComponent(path)}`, 'PUT', {
            message: `Sync: ${path}`,
            content: base64,
            sha: sha || undefined,
            branch: this.settings.branch
        });
        this.addLog(`新增上传: ${path}`);
    }

    async downloadFile(path) {
        try {
            const res = await this.apiRequest(`/repos/${this.settings.repo}/contents/${encodeURIComponent(path)}?ref=${this.settings.branch}`);
            const content = this.base64ToArrayBuffer(res.json.content);
            
            // 处理文件夹路径
            const pathParts = path.split('/');
            if (pathParts.length > 1) {
                let cur = "";
                for (let i = 0; i < pathParts.length - 1; i++) {
                    cur += (cur ? "/" : "") + pathParts[i];
                    if (!(await this.app.vault.adapter.exists(cur))) {
                        await this.app.vault.adapter.mkdir(cur);
                    }
                }
            }
            await this.app.vault.adapter.writeBinary(path, content);
            this.addLog(`更新本地: ${path}`);
        } catch (e) { this.addLog(`下载失败: ${path}`); }
    }

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        const binary_string = window.atob(base64.replace(/\s/g, ''));
        const bytes = new Uint8Array(binary_string.length);
        for (let i = 0; i < binary_string.length; i++) bytes[i] = binary_string.charCodeAt(i);
        return bytes.buffer;
    }
}

// --- 设置 Tab UI ---
class GithubSyncSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'GitHub Sync Pro' });

        const tokenSet = new Setting(containerEl).setName('GitHub Token').setDesc(this.plugin.settings.isTokenLocked ? '已加密锁定' : '输入后连接测试');
        tokenSet.addText(t => t.setValue(this.plugin.settings.isTokenLocked ? '********' : this.plugin.settings.token).setDisabled(this.plugin.settings.isTokenLocked).onChange(v => { this.plugin.settings.token = v; this.plugin.saveSettings(); }));
        tokenSet.addButton(b => b.setButtonText(this.plugin.settings.isTokenLocked ? '重置并删除配置' : '验证并锁定').onClick(async () => {
            if (this.plugin.settings.isTokenLocked) {
                if(confirm("确定重置吗？")){
                    this.plugin.settings = { token: '', repo: '', branch: 'main', syncInterval: 0, autoSyncAfterEdit: 0, excludedRules: [...DEFAULT_EXCLUDES], logs: [], isTokenLocked: false };
                    await this.plugin.saveSettings();
                    this.display();
                }
            } else {
                try {
                    await this.plugin.apiRequest('/user');
                    this.plugin.settings.isTokenLocked = true;
                    await this.plugin.saveSettings();
                    this.display();
                } catch (e) { new Notice("Token 无效"); }
            }
        }));

        if (!this.plugin.settings.isTokenLocked) return;

        new Setting(containerEl).setName('仓库 (Repo)').addDropdown(async d => {
            const res = await this.plugin.apiRequest('/user/repos?per_page=100&sort=updated');
            d.addOption('', '选择仓库...');
            res.json.forEach(r => d.addOption(r.full_name, r.full_name));
            d.setValue(this.plugin.settings.repo).onChange(v => { this.plugin.settings.repo = v; this.plugin.saveSettings(); this.display(); });
        });

        if (this.plugin.settings.repo) {
            new Setting(containerEl).setName('分支 (Branch)').addDropdown(async d => {
                const res = await this.plugin.apiRequest(`/repos/${this.plugin.settings.repo}/branches`);
                res.json.forEach(b => d.addOption(b.name, b.name));
                d.setValue(this.plugin.settings.branch).onChange(v => { this.plugin.settings.branch = v; this.plugin.saveSettings(); });
            });
        }

        new Setting(containerEl).setName('定时同步 (秒)').addText(t => t.setValue(String(this.plugin.settings.syncInterval)).onChange(v => { this.plugin.settings.syncInterval = Number(v); this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('空闲同步 (秒)').addText(t => t.setValue(String(this.plugin.settings.autoSyncAfterEdit)).onChange(v => { this.plugin.settings.autoSyncAfterEdit = Number(v); this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('高级过滤规则').addButton(b => b.setButtonText("管理").onClick(() => new RuleModal(this.app, this.plugin).open()));
        new Setting(containerEl).setName('同步操作').addButton(b => b.setButtonText("立即同步").setCta().onClick(() => { new SyncConfirmModal(this.app, (m) => this.plugin.sync(m)).open(); }));

        containerEl.createEl('h3', { text: '同步日志' });
        const logBox = containerEl.createDiv({ style: "background:#000; color:#0f0; padding:10px; font-family:monospace; font-size:12px; border-radius:4px; height:160px; overflow-y:auto; border:1px solid #444;" });
        this.plugin.settings.logs.forEach(l => logBox.createEl('div', { text: l }));
        
        const logBtns = containerEl.createDiv({ style: "margin-top:10px; display:flex; gap:10px;" });
        logBtns.createEl('button', { text: '复制日志' }).onclick = () => navigator.clipboard.writeText(this.plugin.settings.logs.join('\n'));
        logBtns.createEl('button', { text: '清空日志' }).onclick = () => { this.plugin.settings.logs = []; this.plugin.saveSettings(); this.display(); };
    }
}

// --- 弹窗组件 ---
class SyncConfirmModal extends Modal {
    constructor(app, onConfirm) { super(app); this.onConfirm = onConfirm; }
    onOpen() {
        this.contentEl.createEl('h3', { text: '请选择同步方式' });
        new Setting(this.contentEl).setName('本地覆盖仓库').setDesc('强制将本地所有文件（含配置）推送到 GitHub').addButton(b => b.setButtonText('执行').onClick(() => { this.onConfirm('local_to_remote'); this.close(); }));
        new Setting(this.contentEl).setName('仓库覆盖本地').setDesc('拉取 GitHub 所有文件').addButton(b => b.setButtonText('执行').onClick(() => { this.onConfirm('remote_to_local'); this.close(); }));
        new Setting(this.contentEl).setName('双向增量同步').setDesc('只同步缺失的文件').addButton(b => b.setButtonText('执行').onClick(() => { this.onConfirm('merge'); this.close(); }));
    }
}

class RuleModal extends Modal {
    constructor(app, plugin) { super(app); this.plugin = plugin; }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '管理排除规则' });
        const list = contentEl.createDiv();
        const render = () => {
            list.empty();
            this.plugin.settings.excludedRules.forEach((r, i) => {
                const row = list.createDiv({ style: "display:flex; justify-content:space-between; margin:5px 0; border-bottom: 1px solid #333; padding-bottom:5px;" });
                row.createSpan({ text: r });
                row.createEl('button', { text: '删除', cls: 'mod-warning' }).onclick = () => { this.plugin.settings.excludedRules.splice(i, 1); this.plugin.saveSettings(); render(); };
            });
        };
        render();
        new Setting(contentEl).setName('手动输入规则').setDesc('支持通配符 * (例如 .obsidian/plugins/*)').addText(t => t.setPlaceholder('.git')).addButton(b => b.setButtonText('添加').onClick(() => {
            const v = contentEl.querySelector('input').value;
            if (v) { this.plugin.settings.excludedRules.push(v); this.plugin.saveSettings(); render(); }
        }));
    }
}

module.exports = GithubSyncPro;