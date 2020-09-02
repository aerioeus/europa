'use strict'

const path = require('path')
const request = require('request')
const { app, ipcMain, BrowserWindow, session } = require('electron')
const fs = require('fs');
const os = require('os');

const Window = require('./Window')
const RecentUrlsDB = require('./RecentUrlsDB')
const SettingsDB = require('./SettingsDB')
const electronLocalshortcut = require('electron-localshortcut');
const commandExists = require('command-exists');
const { execSync } = require('child_process')
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { create } = require('domain');
const { settings } = require('cluster');

const EUROPA_HELP_SHORTCUTS_LINK = 'https://github.com/suyashmahar/europa/wiki/Keyboard-shortcuts';
const EUROPA_UNSUPPORTED_JUPYTER_LINK = 'https://github.com/suyashmahar/europa/wiki/Supported-JupyterLab-Versions';

const MAX_RECENT_ITEMS = 4;
const SHORTCUT_SEND_URL = `/lab/api/settings/@jupyterlab/shortcuts-extension:plugin?1598459201550`;
const DRAW_FRAME = true;
const VERSION_STRING = "1.0.0"

/* Create all the data stores */
const recentUrlsDb  = new RecentUrlsDB({ name: 'recent_urls' });
const settingsDb    = new SettingsDB({ name: 'global_settings' });

var appDir = __dirname;
var iconPath;
var mainWindow, settingsWin;

// Tracks all the url opened so far
var urlsOpened = []; 
var JUPYTER_REQ_FILTER = {
  urls: ['*://*/*']
}

// url filter to see if the login was successful 
var JUPYTER_LOGIN_SUCCESS_FILTER = {
  urls: ['*://*/*api/contents/*']
}

// Tracks login for a host
var loginTracker = {}
// Tracks window for a url
var windowTracker = {}
// Tracks the dialog box responses
var dialogRespTracker = {}
// Tracks jupyter format cookie for urls
var jupyterCookieTracker = {}

function fixASARPath() {
  if (appDir.endsWith('.asar')) {
    appDir = path.dirname(appDir);
  }
}

function getPythonInterpreter() {
  var result = undefined;
  var found = commandExists.sync('python3') 
                || commandExists.sync('python');
  if (found) {
    result = execSync(`python -c "import sys; print(sys.executable)"`)
  }

  console.log('Returning: '.concat(result));
  return result;
}

// Monitor the started child process for starting jupyter lab server
function monitorStartServerChild(event, child) {
  child.stdout.on("data", function(data) {
    if (data) {
      event.sender.send('start-server-resp', data);
    }
    console.log("Shell Data: " + data);
  });
  child.stderr.on("data", function(data){
    if (data) {
      event.sender.send('start-server-resp', data);
    }
    console.log("Shell Errors: " + data);
  });

  console.log(`Child.killed = ${child.killed}`)
}

function startServerWindows(event, py, startAt, portNum) {
  var scriptPath = path.join(appDir, 'scripts', 
    'windows', 'start_jupyter_lab.ps1');
    
    // Execute the command async
    var child = spawn("powershell.exe", [scriptPath, `${py} ${startAt} ${portNum}`]);
    monitorStartServerChild(event, child);
}

function startServerLinux(event, py, startAt, portNum) {
  var scriptPath = path.join(appDir, 'scripts', 
    'linux', 'start_jupyter_lab.sh');
    
    // Execute the command async
    var child = spawn("sh", [scriptPath, py, startAt, portNum]);
    console.log(`Running: sh ${scriptPath} ${py} ${startAt} ${portNum}`)
    monitorStartServerChild(event, child);
}

// Runs OS specific script to start a jupyter lab server
function startServerOS(event, py, startAt, portNum) {
  if (process.platform === "win32") {
    startServerWindows(event, py, startAt, portNum);
  } else if (process.platform === "linux") {
    startServerLinux(event, py, startAt, portNum);  
  } else {
    console.error("Unsupported platform " + process.platform);
  }
}

function setupIcons() {
  if (os.platform() === 'win32') {
    iconPath = path.join(__dirname, 'assets', 'img', 'europa_logo.ico');
  } else if (os.platform() == 'linux') {
    iconPath = path.join(__dirname, 'assets', 'img', 'europa_logo.png');
  } else if (os.platform() === 'darwin') {
    iconPath = path.join(__dirname, 'assets', 'img', 'europa_logo.icns');
  } else {
    console.warn(`Platform ${os.platform()} has not icon set.`)
  }
}

function showUnsupportedJupyterMsg(urlObj) {
  /* Show warning for an unsupported version of jupyter lab */
  const props = {
    'type': 'warning',
    'title': 'Unsupported JupyterLab version',
    'content': `<p>Unsupported version of JupyterLab.</p><p class="text-secondary">Some of the Europa's functionality will be disabled (e.g., automatic shortcut configuration). <a onClick="shell.openExternal('${EUROPA_UNSUPPORTED_JUPYTER_LINK}'); return false;" href="javascript:void">Know More</a>.</p>`,
    'primaryBtn': 'OK',
    'secondaryBtn': '',
  }
  createDialog(windowTracker[urlObj.origin], props, `${Date.now()}`, (resp) => {});
}

/**
 * @brief Check if the shortcuts needs to be set (before asking user)
 * Generate a GET request on the keyboard settings URL and compare the response
 */
function shouldSetShortcuts(urlObj, callback) {
  const shortcutDialogEnabled = getSettings()['show-keyboard-shortcuts-dialog'] == 'ask';
  console.log(`shortcutDialogEnabled = ${shortcutDialogEnabled}`);

  if (shortcutDialogEnabled == false) {
    return;
  }

  var reqUrl = `${urlObj.origin}/lab/api/settings/@jupyterlab/shortcuts-extension:shortcuts?${Date.now()}`;
  console.log(reqUrl)
  request.get(
    {
      url : reqUrl,
      headers: {
        'Host': urlObj.host,
        'Origin': urlObj.origin,
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'cookie': jupyterCookieTracker[urlObj.origin]['cookie'],
        'X-XSRFToken': jupyterCookieTracker[urlObj.origin]['xsrf'],
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36' 
      }
    },
    function (error, response, body) {
      // console.log(error)
      // console.log(response)
      var result = false;
      if (!error) {
        var rcvData = JSON.parse(body);
        if (rcvData['raw']) {
          if (rcvData['raw'].length == 2) {
            result = true;
          }
        } else {
          showUnsupportedJupyterMsg(urlObj);
        }
      } else {
        showUnsupportedJupyterMsg(urlObj);
      }
      callback(result);
    }); 
}

function askUserForShortcuts(url, window) {
  var props = {
    'type': 'question',
    'title': 'Set shorcuts?',
    'primaryBtn': 'Yes',
    'secondaryBtn': 'No',
    'content': `
      <p>Set JupyterLab shortcuts for Europa?</p>
      <p class="text-secondary">E.g., Alt+Tab to switch tabs. Note that these 
      changes are persistent. 
        <a onClick="shell.openExternal('${EUROPA_HELP_SHORTCUTS_LINK}'); return false;" href="javascript:void">
          Know More
        </a>
      </p>`
  }

  var id = url+'_ask_shortcuts';
  createDialog(window, props, id, (resp) => { 
    if (resp == 'primary') {
      sendShortcuts(id);
    }
  });
}

/**
 * Sends a PUT request for the custom shortcut to link in the id
 * @param {string} id url + tag
 */
function sendShortcuts(id) {
  var url = id.replace(/_ask_shortcuts/, '');
  var urlObj = new URL(url);

  const shortcutsFile = path.join(
    appDir, 'config', 'jupyter_keyboard_shortcuts.json'
  );
  const jsonData = fs.readFileSync(shortcutsFile);
  request.put(   
  {
    url : `${urlObj.origin}/lab/api/settings/@jupyterlab/shortcuts-extension:shortcuts?${Date.now()}`,
    headers: {
      'Host': urlObj.host,
      'Origin': urlObj.origin,
      'Connection': 'keep-alive',
      'Content-Type': 'text/plain',
      'Content-Length': jsonData.length,
      'cookie': jupyterCookieTracker[urlObj.origin]['cookie'],
      'X-XSRFToken': jupyterCookieTracker[urlObj.origin]['xsrf'],
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36' 
    },
    body: jsonData
  },
  function (error, response, body) {
    if (!error) {
      windowTracker[urlObj.origin].reload();
    }
  }); 
}

/**
 * Creates a dialog box
 * @param {BrowserWindow} window 
 * @param {dictionary} props Properties of the dialog box, check dialogbox.js
 * @param {string} id unique identifier for this dialog box
 */
function createDialog(window, props, id, callback) {
  var dialogBox = new Window({
    file: path.join('renderer', 'dialog_box', 'dialogbox.html'),
    width: 500,
    height: 230,
    icon: iconPath,
    frame: DRAW_FRAME,
    useContentSize: true,
    // close with the main window
    parent: window
  })

  electronLocalshortcut.register(dialogBox, 'Esc', () => {
    dialogBox.close();
  });

  dialogBox.webContents.on('did-finish-load', () => {
    dialogBox.webContents.send('construct', props, id);
  });
  
  dialogRespTracker[id] = callback;


}

function startHTTPProxy() {
  const webRequest = session.defaultSession.webRequest
  webRequest.onBeforeSendHeaders(JUPYTER_REQ_FILTER, 
      (details, callback) => {
      if (details.uploadData) {
        const buffer = Array.from(details.uploadData)[0].bytes;
      }
      callback(details);
  });

  webRequest.onHeadersReceived(JUPYTER_LOGIN_SUCCESS_FILTER, 
    (details, callback) => {
      if (details) {
        var urlObj = new URL(details.url);
        if (!(urlObj.origin in loginTracker)) {
          loginTracker[urlObj.origin] = true;

          getCookies(details.url, () => {
            shouldSetShortcuts(urlObj, (result) => {
              if (result) {
                askUserForShortcuts(details.url, windowTracker[urlObj.origin]);
              }
            });
          })
        }
      }
      callback(details);
  });
}

function getCookies(urlRequested, callback) {
  const urlObj = new URL(urlRequested);
  var domain = urlObj.hostname;

  const result = 
    session.defaultSession.cookies.get(
      {domain}, 
      (error, result) => {
        var key = urlObj.origin;
        
        console.log(`Total ${result.length} cookies found`)

        /* Generate cookie in JupyterLab's format */
        jupyterCookieTracker[key] = {'cookie': undefined, 'xsrf': undefined};
        jupyterCookieTracker[key]['cookie'] = result[0]['name'];
        jupyterCookieTracker[key]['cookie'] += '=';
        jupyterCookieTracker[key]['cookie'] += result[0]['value'];
        jupyterCookieTracker[key]['cookie'] += '; ';
        jupyterCookieTracker[key]['cookie'] += result[1]['name'];
        jupyterCookieTracker[key]['cookie'] += '=';
        jupyterCookieTracker[key]['cookie'] += result[1]['value'];

        console.log(`Cookie generated: ${jupyterCookieTracker[key]['cookie']}`);

        jupyterCookieTracker[key]['xsrf'] = result[0]['value'];

        console.log(`XSRF generated: ${jupyterCookieTracker[key]['xsrf']}`);

        callback();
      }
    )

  return result;
}

function addTrackingForUrl(url) {
  console.log('Starting tracking for ' + url);
}

function removeTrackingForUrl(url) {
  console.log('Removing tracking for ' + url);
  const urlObj = new URL(url);
  if (urlObj.origin in loginTracker) {
    delete loginTracker[urlObj.origin];
  }
}

function show404(event, errorCode, errorDescription, validatedUrl, isMainFrame) {
  event.sender.webContents.removeListener('did-fail-load', show404);

  event.sender.loadURL(pathToFileURL('renderer/404_page/404page.html').href);

  electronLocalshortcut.register(event.sender, 'Ctrl+R', () => {
    event.sender.loadURL(validatedUrl);
  });
}

function showOptionsWindow() {
  if (!settingsWin) {
    // create a new add todo window
    settingsWin = new Window({
      file: path.join('renderer', 'settings_page', 'settings.html'),
      width: 700,
      height: 600,
      icon: iconPath,
      frame: DRAW_FRAME,

      // close with the main window
      parent: mainWindow
    })
   
    // cleanup
    settingsWin.on('closed', () => {
      settingsWin = null
    })
    
    // Register shortcuts
    electronLocalshortcut.register(settingsWin, 'Esc', () => {
      settingsWin.close();
    });

    settingsWin.webContents.on('did-finish-load', () => {
      settingsWin.webContents.send('settings-value', getSettings());
    });
  }
}

function clearCache() {
  session.defaultSession.clearStorageData();
}

function setSettings(settingsObj) {
  settingsDb.saveSettings(settingsObj);
}

function getSettings(settingsObj) {
  return settingsDb.getSettings();
}

function showAboutDialog(win) {
  const aboutDialogContents = `
    <h4>About Europa v${VERSION_STRING}</h4>
    <p>Copyright &#169; 2020 Suyash Mahar</p>
    <p class="text-secondary">
      This program is distributed under the terms of the 
      <a onClick="shell.openExternal('https://www.gnu.org/licenses/gpl-3.0.en.html'); return false;" href="javascript:void">GPL v3</a>. 
      Link to the 
      <a class="text-small" onClick="shell.openExternal('https://github.com/suyashmahar/europa'); return false;" href="javascript:void">
        Source code.
      </a>
    </p>
  `;

  const props = {
    'type': 'info',
    'title': 'About Europa',
    'content': aboutDialogContents,
    'primaryBtn': 'OK',
    'secondaryBtn': ''
  };

  createDialog(mainWindow, props, String(Date.now()), () => void 0);
}

function main() {
  fixASARPath();

  console.log(settingsDb.getSettings());

  setupIcons();
  startHTTPProxy();
  
  // Menu.setApplicationMenu(null);

  mainWindow = new Window({
    file: path.join('renderer', 'welcome.html'),
    titleBarStyle: "hidden",
    icon: iconPath,
    frame: DRAW_FRAME,
  })
  
  let addTodoWin
  let newServerDialog

  mainWindow.once('show', () => {
    mainWindow.webContents.send('recent-urls', recentUrlsDb.urls)
  })

  ipcMain.on('get-sys-cfg-jupyter-lab', (event) => {
    var resp = (
      getPythonInterpreter()
    );
    event.sender.send('asynchronous-reply', resp);
  });

  ipcMain.on('start-server', (event, py, startAt, portNum) => {
    startServerOS(event, py, startAt, portNum)
  });

  ipcMain.on('save-settings', (event, settingsObj) => {
    setSettings(settingsObj);
  });

  ipcMain.on('show-about-europa', (event, settingsObj) => {
    showAboutDialog(event.sender);
  });

  ipcMain.on('clear-cache', (event, settingsObj) => {
    console.log('Clearing cache');
    clearCache();
  });

  ipcMain.on('open-url-window', () => {
    if (!addTodoWin) {
      // create a new add todo window
      addTodoWin = new Window({
        file: path.join('renderer', 'add_url', 'add_url.html'),
        width: 500,
        height: 120,
        resizable: false,
        icon: iconPath,
        frame: DRAW_FRAME,

        // close with the main window
        parent: mainWindow
      })
     
      // Disable menu bar
      addTodoWin.removeMenu();
      
      // cleanup
      addTodoWin.on('closed', () => {
        addTodoWin = null
      })
      
      // Register shortcuts
      electronLocalshortcut.register(addTodoWin, 'Esc', () => {
        addTodoWin.close();
      });
    }
  })

  ipcMain.on('options-window', showOptionsWindow);

  // create add todo window
  ipcMain.on('new-server-window', () => {
    if (!newServerDialog) {
      newServerDialog = new Window({
        file: path.join('renderer', 'new_server', 'newserver.html'),
        width: 600,
        height: 450,
        maxWidth: 600,
        maxHeight: 450,
        minWidth: 600,
        minHeight: 450,
        // close with the main window
        parent: mainWindow,
        icon: iconPath,
        frame: DRAW_FRAME,
      })

      // Disable menu bar
      newServerDialog.removeMenu();

      // Register shortcuts
      electronLocalshortcut.register(newServerDialog, 'Esc', () => {
        newServerDialog.close();
      });

      // cleanup
      newServerDialog.on('closed', () => {
        newServerDialog = null;
      })
    }
  })

  ipcMain.on('open-url', (e, url) => {
    // Track for login on the opened url
    addTrackingForUrl(url);
    var urlObj = new URL(url)
    
    // Create a title for the new window
    var windowTitle = 'Europa @ '.concat(url.substring(0, 100));
    if (url.length > 100) {
      windowTitle.concat('...');
    }
    
    var newJupyterWin = new BrowserWindow({
      width: 1080,
      height: 768,
      preload: path.join(appDir, 'js', 'preload404.js'),
      webPreferences: {
        nodeIntegration: false
      },
      icon: iconPath,
      frame: DRAW_FRAME,
      title: windowTitle
    })
    
    windowTracker[urlObj.origin] = newJupyterWin;
    newJupyterWin.loadURL(url);

    /* Set did-fail-load listener once */
    newJupyterWin.webContents.on("did-fail-load", show404);
    
    // Disable menu bar
    newJupyterWin.removeMenu();

    // cleanup
    newJupyterWin.on('closed', () => {
      newJupyterWin = null
      removeTrackingForUrl(url);
    })
    newJupyterWin.once('ready-to-show', () => {
      newJupyterWin.show()
    })

    // Prevent the title from being updated
    newJupyterWin.on('page-title-updated', (evt) => {
      evt.preventDefault();
    });

    /* Register shortcuts */
    electronLocalshortcut.register(newJupyterWin, 'Ctrl+Shift+W', () => {
      newJupyterWin.close();
    });
  })

  ipcMain.on('add-recent-url', (event, url) => {
    const updatedUrls = recentUrlsDb.pushFront(url, MAX_RECENT_ITEMS).urls

    mainWindow.send('recent-urls', updatedUrls)
  })

  ipcMain.on('delete-recent-url', (event, url) => {
    const updatedUrls = recentUrlsDb.remove(url).urls

    mainWindow.send('recent-urls', updatedUrls)
  })

  ipcMain.on('dialog-result', (event, id, resp) => {
    dialogRespTracker[id](resp);
  });

  console.log(`appDir: ${appDir}`)
  console.log(`appDir: ${app.getAppPath()}`)
}

app.on('ready', main)

app.on('window-all-closed', function () {
  app.quit()
})
