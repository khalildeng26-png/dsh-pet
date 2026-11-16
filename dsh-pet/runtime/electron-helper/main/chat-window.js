/**
 * 独立聊天窗口:一个普通的深色竖条窗口,加载同目录 chat.html,页面经 dsh-pet-bridge
 * 协议直接调宿主的 /chat、/voice 接口——不依赖 DSH 网页端,桌面-only 用户也能聊。
 * 不置顶:与宠物同档置顶会在拖拽宠物时每帧重排 z 序,聊天窗闪屏——防宠物盖窗交给
 * ambient-collision 的障碍物推离(宠物会被物理弹开),窗口本身保持普通层级即可。
 * 可见时把自己注册为碰撞障碍物;单实例;入口在托盘菜单(见 tray.js 的 openChat)。
 * @module dsh-pet/runtime/electron-helper/main/chat-window
 */
const path = require('node:path');

/**
 * @param {{ BrowserWindow: typeof import('electron').BrowserWindow, helperDir: string, isBridge: boolean, origin: string }} deps
 */
function createChatWindow({ BrowserWindow, helperDir, isBridge, origin }) {
  const base = isBridge ? 'dsh-pet-bridge://dsh-pet/dsh-pet-7340' : origin + '/dsh-pet-7340';
  let win = null;

  function open(petId) {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 380,
      height: 660,
      minWidth: 300,
      minHeight: 420,
      show: false,
      useContentSize: true,
      backgroundColor: '#0e1621',
      autoHideMenuBar: true,
      title: 'dsh-pet 聊天',
      skipTaskbar: false,
      webPreferences: {
        contextIsolation: true,
      },
    });
    const query = { pet: petId || 'main', surface: 'desktop', base };
    win.loadFile(path.join(helperDir, 'chat.html'), { query }).catch((error) => {
      console.error('[dsh-pet chat] load failed:', error && error.message ? error.message : error);
    });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      win = null;
    });
  }

  /**
   * 碰撞障碍矩形(工作区坐标,与 petStates 同一坐标系):
   * 窗口可见时返回内容区矩形,宠物弹到上面会被推开;隐藏/销毁返回 null(不挡路)。
   */
  function obstacleBounds() {
    if (!win || win.isDestroyed() || !win.isVisible()) return null;
    const b = win.getContentBounds();
    return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
  }

  function toggle(petId) {
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      open(petId);
    }
  }

  return { open, toggle, obstacleBounds };
}

module.exports = { createChatWindow };
