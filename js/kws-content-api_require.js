(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/*
 * (C) Copyright 2013 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */


var EventEmitter = require("events").EventEmitter;
var inherits     = require('inherits');

var XMLHttpRequest = require("xmlhttprequest");

var RpcBuilder     = require("kws-rpc-builder");
var JsonRPC        = RpcBuilder.packers.JsonRPC;


const MAX_FRAMERATE = 15;


/**
 * @constructor
 * @abstract
 *
 * @param {String} url: URL of the WebRTC endpoint server.
 * @param {Object} options: optional configuration parameters
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} audio: audio stream mode
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} video: video stream mode
 *   {[Object]} iceServers: array of objects to initialize the ICE servers. It
 *     structure is the same as an Array of WebRTC RTCIceServer objects.
 *
 * @throws RangeError
 */
function Content(url, options)
{
  EventEmitter.call(this);

  var self = this;


  const ERROR_NO_REMOTE_VIDEO_TAG = -1;


  /**
   * Decode the mode of the streams
   *
   * @private
   *
   * @param {Object} options: constraints to update and decode
   * @param {String} type: name of the constraints to decode
   *
   * @returns {Object}
   *
   * @throws RangeError
   */
  function decodeMode(options, type)
  {
    var result = {};

    // If not defined, set send & receive by default
    options[type] = options[type] || 'sendrecv';

    switch(options[type])
    {
      case 'sendrecv':
        result.local  = true;
        result.remote = true;
      break;

      case 'sendonly':
        result.local  = true;
        result.remote = false;
      break;

      case 'recvonly':
        result.local  = false;
        result.remote = true;
      break;

      case 'inactive':
        result.local  = false;
        result.remote = false;
      break;

      default:
        throw new RangeError("Invalid "+type+" media mode");
    }

    return result;
  }

  // We can't disable both audio and video on a stream, raise error
  if(options.audio == 'inactive' && options.video == 'inactive')
    throw new RangeError("At least one audio or video must to be enabled");

  // Audio media
  this._audio = decodeMode(options, "audio");

  // Video media
  this._video = decodeMode(options, "video");

  if(this._video.local)
      this._video.local =
      {
        mandatory:
        {
//          minHeight   : options.minHeight    || MIN_HEIGHT,
//          maxHeight   : options.maxHeight    || MAX_HEIGHT,
//          minWidth    : options.minWidth     || MIN_WIDTH,
//          maxWidth    : options.maxWidth     || MAX_WIDTH,
//          minFrameRate: options.minFrameRate || MIN_FRAMERATE,
          maxFrameRate: options.maxFrameRate || MAX_FRAMERATE
        }
      };

  // Init the KwsWebRtcContent object

  var _sessionId = null;
  var pollingTimeout = null;
  var polling = false;
  var terminatedByServer = false;


  this.__defineGetter__('sessionId', function()
  {
    return _sessionId;
  });


  function setSessionId(sessionId)
  {
    if(sessionId == undefined)
      throw new TypeError('sessionId is undefined');

    if(_sessionId == undefined)
      _sessionId = sessionId;

    else if(sessionId != _sessionId)
      throw new TypeError('sessionId is not equal to already defined one');
  }


  var rpc = new RpcBuilder(JsonRPC, {request_timeout: 30000});


  function doRPC(method, params, callback)
  {
    var xhr = new XMLHttpRequest();

    // Set XmlHttpRequest error callback
    xhr.addEventListener('error', function(error)
    {
      self.emit('error', error);
    });

    // Connect to Content Server
    xhr.open('POST', url);

    // Send request
    xhr.send(rpc.encode(method, params, callback));

    // Register callback for the Application Server
    xhr.addEventListener('load', function()
    {
      rpc.decode(this.responseText);
    });
  };


  function close()
  {
//    xhr.abort();

    _sessionId = null;
  };

  self.on('error',     close);
  self.on('terminate', close);


  // Error dispatcher functions

  var MAX_ALLOWED_ERROR_TRIES = 10;

  var error_tries = 0;


  // RPC calls

  // Start

  this.start = function(params, success)
  {
    if(this.sessionId)
      params.sessionId = this.sessionId;

    doRPC('start', params, function(error, result)
    {
      error = error || result.rejected;

      if(error) return self.emit('error', error);

      setSessionId(result.sessionId);

      success(result);
    });
  };


  // Poll

  /**
   * Poll for events dispatched on the server pipeline
   *
   * @private
   */
  function pollMediaEvents()
  {
    if(!self.sessionId) return;

    if(!polling) return;

    var params =
    {
      sessionId: self.sessionId
    };

    function success(result)
    {
      error_tries = 0;

      // Content events
      if(result.contentEvents)
        for(var i=0, data; data=result.contentEvents[i]; i++)
          self.emit('mediaevent', data);

      // Control events
      if(result.controlEvents)
        for(var i=0, data; data=result.controlEvents[i]; i++)
        {
          var type = data.type;

          switch(type)
          {
            case "sessionTerminated":
              terminatedByServer = true;
              self.emit('terminate', Content.REASON_SERVER_ENDED_SESSION);
            break;

            case "sessionError":
              self.emit('error', data.data);
            break;

            default:
              console.warn("Unknown control event type: "+type);
          }
        };

      // Check if we should keep polling events
      if(pollingTimeout != 'stopped')
      {
        clearTimeout(pollingTimeout);
        pollingTimeout = setTimeout(pollMediaEvents, 0);
      }
    };

    function failure(error)
    {
      // A poll error has occurred, retry it
      if(error.code != -32602 && error_tries < MAX_ALLOWED_ERROR_TRIES)
      {
        if(pollingTimeout != 'stopped')
        {
          clearTimeout(pollingTimeout);
          pollingTimeout = setTimeout(pollMediaEvents, Math.pow(2, error_tries)*1000);
        }

        error_tries++;
      }

      // Max number of poll errors achieved, raise error
      else
        terminateConnection('error', error);
    };

    doRPC('poll', params, function(error, result)
    {
      if(error) return failure(error);

      success(result);
    });
  };

  function startPolling()
  {
    if(polling) return;

    polling = true;
    pollMediaEvents()
  };

  this.on('start',   startPolling);
  this.on('execute', startPolling);


  /**
   * Terminate the connection with the WebRTC media server
   */
  function terminateConnection(action, reason)
  {
    // Stop polling
    clearTimeout(pollingTimeout);
    pollingTimeout = 'stopped';
    polling = false;

    if(terminatedByServer)
      return;

    // Notify to the WebRTC endpoint server
    if(self.sessionId)
    {
      var params =
      {
        sessionId: self.sessionId,
        reason: reason
      };

      doRPC('terminate', params, function()
      {
        self.emit(action, reason);
      });

      _sessionId = null;
    };
  };


  //
  // Methods
  //

  /**
   * @private
   */
  this._setRemoteVideoTag = function(src)
  {
    var remoteVideo = document.getElementById(options.remoteVideoTag);
    if(remoteVideo)
    {
      remoteVideo.src = src;

      return remoteVideo;
    };

    var msg = "Requested remote video tag '" + options.remoteVideoTag
            + "' is not available";

    var error = new Error(msg);
        error.code = ERROR_NO_REMOTE_VIDEO_TAG;

    self.emit('error', error);
  };


  /**
   * Send a command to be executed on the server
   *
   * @param {string} type - The command to execute
   * @param {*} data - Data needed by the command
   * @param {} callback - Function executed after getting a result or an error
   */
  this.execute = function(type, data, callback)
  {
    callback = callback || function(){};

    var params =
    {
      command:
      {
        type: type,
        data: data
      }
    };

    if(this.sessionId)
      params.sessionId = this.sessionId;

    doRPC('execute', params, function(error, result)
    {
      if(error) return callback(error);

      setSessionId(result.sessionId);

      self.emit('execute');
      callback(null, result.commandResult);
    });
  }

  /**
   * Close the connection
   */
  this.terminate = function()
  {
    terminateConnection('terminate', Content.REASON_USER_ENDED_SESSION);
  };
};
inherits(Content, EventEmitter);


Content.REASON_USER_ENDED_SESSION =
{
  code: 1,
  message: "User ended session"
};
Content.REASON_SERVER_ENDED_SESSION =
{
  code: 2,
  message: "Server ended session"
};


module.exports = Content;

},{"events":6,"inherits":7,"kws-rpc-builder":9,"xmlhttprequest":13}],2:[function(require,module,exports){
/*
 * (C) Copyright 2013 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */


var Content = require("./Content");

var inherits = require("inherits");


/**
 * @constructor
 *
 * @param {String} url: URL of the WebRTC endpoint server.
 * @param {Object} options: optional configuration parameters
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} audio: audio stream mode
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} video: video stream mode
 *   {[Object]} iceServers: array of objects to initialize the ICE servers. It
 *     structure is the same as an Array of WebRTC RTCIceServer objects.
 *   {Boolean} [autostart=true]: flag to manually start media
 *
 * @throws RangeError
 */
function KwsContentPlayer(url, options)
{
  options = options || {};

  if(options.autostart == undefined)
     options.autostart = true;

  Content.call(this, url, options);

  var self = this;

  var Content_start = this.start;


  /**
   * Callback when connection is succesful
   *
   * @private
   *
   * @param {Object} response: JsonRPC response
   */
  function success(result)
  {
    // Remote streams
    if(self._video.remote)
    {
      var url = result.url;

      if(options.remoteVideoTag)
      {
        var remoteVideo = self._setRemoteVideoTag(url);

        remoteVideo.addEventListener('ended', function()
        {
          self.terminate();
        })
      }
      else
        console.warn("No remote video tag available, successful terminate event due to remote end will be no dispatched");

      self.emit('remotestream', {url: url});
    };

    // Notify we created the connection successfully
    self.emit('start');
  };


  // RPC calls

  // Start

  /**
   * Request a connection with the webRTC endpoint server
   *
   * @private
   */
  this.start = function()
  {
    var params =
    {
      constraints:
      {
        audio: options.audio,
        video: options.video
      }
    };

    Content_start.call(self, params, success);
  };

  if(options.autostart)
    this.start();


  function close(reason)
  {
    if(reason == Content.REASON_SERVER_ENDED_SESSION)
      return;

    var remoteVideo = document.getElementById(options.remoteVideoTag);
    if(remoteVideo) {
        remoteVideo.src = '';
        remoteVideo.removeAttribute('src');
    }
  };

  this.on('error',     close);
  this.on('terminate', close);
};
inherits(KwsContentPlayer, Content);


module.exports = KwsContentPlayer;

},{"./Content":1,"inherits":7}],3:[function(require,module,exports){
/*
 * (C) Copyright 2013 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */


/*
 * @module kwsContentApi
 */

var Content = require("./Content");

var inherits       = require("inherits");
var XMLHttpRequest = require("xmlhttprequest");


function drop(event)
{
  event.stopPropagation();
  event.preventDefault();

  this._filesContainer = event.dataTransfer;
};
function dragover(event)
{
  event.stopPropagation();
  event.preventDefault();

  event.dataTransfer.dropEffect = 'copy'; // Explicitly show this is a copy.
};

/**
 * Upload a file to a Media Server
 * 
 * @constructor
 * @extend Content
 * 
 * @param {string} url - URL of the Connect Server endpoint
 * @param {KwsContentUploader} [options]
 */
function KwsContentUploader(url, options)
{
  options = options || {};

  if(options.autostart == undefined)
     options.autostart = true;

  Content.call(this, url, options);

  var self = this;

  var Content_start = this.start;


  function sendFiles(container)
  {
    var files = container.files;
    if(files)
      self.send(files);
  };


  var url;

  function doSend(file)
  {
    // XmlHttpRequest object used to upload the files
    var xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('error', function(error)
    {
      self.emit('error', error);
    });
    xhr.upload.addEventListener('load', function(event)
    {
      console.log(event);
      self.emit('localfile');
//      self.emit('localfile', file);
    });

    // Connect to Media Server
    xhr.open('POST', url);

    // Send the file
    xhr.send(file);
  };


  function success(result)
  {
    // Set the url where to upload the file
    url = result.url;

    //
    // Set events on elements (if specified)
    //

    // Input tag
    var inputTag = options.inputTag;
    if(inputTag)
    {
      var input = document.getElementById(inputTag);
      if(!input)
        throw new SyntaxError("ID "+inputTag+" was not found");

      input.addEventListener('change', function(event)
      {
        sendFiles(input);
      });

      // Send previously selected files
      sendFiles(input);
    };

    // Drag & Drop area
    var dragdropTag = options.dragdropTag;
    if(dragdropTag)
    {
      var div = document.getElementById(dragdropTag);
      if(!div)
        throw new SyntaxError("ID "+dragdropTag+" was not found");

      // Set events if they were not set before
      div.addEventListener('drop', drop);
      div.addEventListener('dragover', dragover);

      // Send previously dropped files
      var filesContainer = div._filesContainer;
      if(filesContainer)
        sendFiles(filesContainer);
    };

    self.emit('start');
  };


  /**
   * Request to the content server the URL where to upload the file
   */
  this.start = function()
  {
    var params =
    {
      constraints:
      {
        audio: 'sendonly',
        video: 'sendonly'
      }
    };

    Content_start.call(self, params, success);
  };

  if(options.autostart)
    this.start();


  //
  // Methods
  //

  /**
   * Upload a file
   * 
   * @param {File} file - media file to be uploaded to the server
   */
  this.send = function(file)
  {
    if(!this.sessionId)
      throw new SyntaxError("Connection with media server is not stablished");

    // Fileset
    if(file instanceof FileList)
    {
      // Fileset with several files
      if(file.lenght > 1)
      {
        var formData = new FormData();
        for(var i=0, f; f=file[i]; i++)
          formData.append("file_"+i, f);
        file = formData;
      }

      // Fileset with zero or one files
      else
        file = file[0];
    }

    // Forced usage of FormData
    else if(options.useFormData)
    {
      var formData = new FormData();
      formData.append("file", file);
      file = formData;
    }

    // Send the file
    doSend(file);
  };
};
inherits(KwsContentUploader, Content);


KwsContentUploader.initDragDrop = function(id)
{
  var div = document.getElementById(id);
  if(!div)
    throw new SyntaxError("ID "+id+" was not found");

  div.addEventListener('drop', drop);
  div.addEventListener('dragover', dragover);
};


/**
 * @typedef {object} KwsContentUploader
 * @property {Boolean} [useFormData] - select if files should be uploaded as raw
 *   Blobs or inside a FormData object
 * @property {string} [inputTag] - ID of the input tag that will host the file
 * @property {string} [dragdropTag] - ID of the element where to drop the files
 */


module.exports = KwsContentUploader;

},{"./Content":1,"inherits":7,"xmlhttprequest":13}],4:[function(require,module,exports){
/*
 * (C) Copyright 2013 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */


var Content = require("./Content");

var inherits = require("inherits");


/**
 * @constructor
 *
 * @param {String} url: URL of the WebRTC endpoint server.
 * @param {Object} options: optional configuration parameters
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} audio: audio stream mode
 *   {Enum('inactive', 'sendonly', 'recvonly', 'sendrecv')} video: video stream mode
 *   {[Object]} iceServers: array of objects to initialize the ICE servers. It
 *     structure is the same as an Array of WebRTC RTCIceServer objects.
 *
 * @throws RangeError
 */
function KwsWebRtcContent(url, options)
{
  options = options || {};

  if(options.autostart == undefined)
     options.autostart = true;

  Content.call(this, url, options);

  var self = this;

  var Content_start = this.start;


  var pc = null;


  function onerror(error)
  {
    self.emit('error', error);
  };


  /**
   * Request a connection with the webRTC endpoint server
   *
   * @private
   *
   * @param {MediaStream | undefined} localStream: stream locally offered
   */
  function initRtc(localStream)
  {
    if(localStream)
      console.log('User has granted access to local media.');

    // Create the PeerConnection object
    var iceServers = options.iceServers
                  || [{url: 'stun:'+'stun.l.google.com:19302'}];

    pc = new RTCPeerConnection
    (
      {iceServers: iceServers},
      {optional: [{DtlsSrtpKeyAgreement: true}]}
    );

    // Add the local stream if defined
    if(localStream)
      pc.addStream(localStream);

    var mediaConstraints =
    {
      mandatory:
      {
        OfferToReceiveAudio: self._audio.remote,
        OfferToReceiveVideo: self._video.remote
      }
    };

    pc.createOffer(function(offer)
    {
      // Set the peer local description
      pc.setLocalDescription(offer,
      function()
      {
        console.info("LocalDescription correctly set");
      },
      onerror);
    },
    onerror,
    mediaConstraints);

    // PeerConnection events

    pc.onicecandidate = function(event)
    {
      // We are still generating the candidates, don't send the SDP yet.
      if(event.candidate) return;

      var params =
      {
        sdp: pc.localDescription.sdp,
        constraints:
        {
          audio: options.audio,
          video: options.video
        }
      };

      console.debug('offer: '+params.sdp);

      Content_start.call(self, params, success);
    };

    // Dispatch 'close' event if signaling gets closed
    pc.onsignalingstatechange = function(event)
    {
      if(pc.signalingState == "closed")
        self.emit('terminate');
    };
  }


  /**
   * Callback when connection is succesful
   *
   * @private
   *
   * @param {Object} response: JsonRPC response
   */
  function success(result)
  {
    console.debug('answer: '+result.sdp);

    // Set answer description and init local environment
    pc.setRemoteDescription(new RTCSessionDescription(
    {
      type: 'answer',
      sdp: result.sdp
    }),
    success2,
    onerror);
  };

  function success2()
  {
    // Local streams
    if(self._video.local)
    {
      var stream = pc.getLocalStreams()[0];
      if(!stream)
        return onerror(new Error("No local streams are available"));

      var url = URL.createObjectURL(stream);

      if(options.localVideoTag)
      {
        var localVideo = document.getElementById(options.localVideoTag);
        if(!localVideo)
        {
          var msg = "Requested local video tag '"+options.localVideoTag
                  + "' is not available";
          return onerror(new Error(msg));
        };

        localVideo.muted = true;
        localVideo.src = url;
      };

      self.emit('localstream', {stream: stream, url: url});
    };

    // Remote streams
    if(self._video.remote)
    {
      var stream = pc.getRemoteStreams()[0];
      if(!stream)
        return self.emit('error', new Error("No remote streams are available"));

      var url = URL.createObjectURL(stream);

      if(options.remoteVideoTag)
      {
        var remoteVideo = self._setRemoteVideoTag(url);

      }
      else
        console.warn("No remote video tag available, successful terminate event due to remote end will be no dispatched");

      self.emit('remotestream', {stream: stream, url: url});
    };

    // Notify we created the connection successfully
    self.emit('start');
  };


  /**
   * Terminate the connection with the WebRTC media server
   */
  function close()
  {
    if(pc.signalingState == "closed")
      return;

    // Close the PeerConnection
    pc.close();
  };

  this.on('error',     close);
  this.on('terminate', close);


  // Mode set to send local audio and/or video stream
  this.start = function()
  {
    var audio = this._audio.local;
    var video = this._video.local;

    if(audio || video)
    {
      var constraints =
      {
        audio: audio,
        video: video
      };

      getUserMedia(constraints, initRtc, onerror);
    }

    // Mode set to only receive a stream, not send it
    else
      initRtc();
  }

  if(options.autostart)
    this.start();
};
inherits(KwsWebRtcContent, Content);


module.exports = KwsWebRtcContent;

},{"./Content":1,"inherits":7}],5:[function(require,module,exports){
/*
 * (C) Copyright 2013 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

/**
 * @module kwsContentApi
 *
 * @copyright 2013 Kurento (http://kurento.org/)
 * @license LGPL
 */

var KwsContentPlayer   = require('./KwsContentPlayer');
var KwsContentUploader = require('./KwsContentUploader');
var KwsWebRtcContent   = require('./KwsWebRtcContent');


exports.KwsContentPlayer   = KwsContentPlayer;
exports.KwsContentUploader = KwsContentUploader;
exports.KwsWebRtcContent   = KwsWebRtcContent;
},{"./KwsContentPlayer":2,"./KwsContentUploader":3,"./KwsWebRtcContent":4}],6:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        throw TypeError('Uncaught, unspecified "error" event.');
      }
      return false;
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],7:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],8:[function(require,module,exports){
function Mapper()
{
  var sources = {};


  this.forEach = function(callback)
  {
    for(var key in sources)
    {
      var source = sources[key];

      for(var key2 in source)
        callback(source[key2]);
    };
  };

  this.get = function(id, source)
  {
    var ids = sources[source];
    if(ids == undefined)
      return undefined;

    return ids[id];
  };

  this.remove = function(id, source)
  {
    var ids = sources[source];
    if(ids == undefined)
      return;

    delete ids[id];

    if(!Object.keys(ids).length)
      delete sources[source];
  };

  this.set = function(value, id, source)
  {
    if(value == undefined)
      return this.remove(id, source);

    var ids = sources[source];
    if(ids == undefined)
      sources[source] = ids = {};

    ids[id] = value;
  };
};


Mapper.prototype.pop = function(id, source)
{
  var value = this.get(id, source);
  if(value == undefined)
    return undefined;

  this.remove(id, source);

  return value;
};


module.exports = Mapper;

},{}],9:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var EventEmitter = require('events').EventEmitter;

var inherits = require('inherits');

var packers = require('./packers');
var Mapper = require('./Mapper');


const BASE_TIMEOUT = 5000;


function unifyResponseMethods(responseMethods)
{
  if(!responseMethods) return {};

  for(var key in responseMethods)
  {
    var value = responseMethods[key];

    if(typeof value == 'string')
      responseMethods[key] =
      {
        response: value
      }
  };

  return responseMethods;
};

function unifyTransport(transport)
{
  if(!transport) return;

  if(transport instanceof Function)
    return transport;

  if(transport.send instanceof Function)
    return transport.send.bind(transport);

  if(transport.postMessage instanceof Function)
    return transport.postMessage.bind(transport);

  // Transports that only can receive messages, but not send
  if(transport.onmessage !== undefined) return;

  throw new SyntaxError("Transport is not a function nor a valid object");
};


/**
 * Representation of a RPC notification
 *
 * @class
 *
 * @constructor
 *
 * @param {String} method -method of the notification
 * @param params - parameters of the notification
 */
function RpcNotification(method, params)
{
  Object.defineProperty(this, 'method', {value: method, enumerable: true});
  Object.defineProperty(this, 'params', {value: params, enumerable: true});
};


/**
 * @class
 *
 * @constructor
 */
function RpcBuilder(packer, options, transport, onRequest)
{
  var self = this;

  if(!packer)
    throw new SyntaxError('Packer is not defined');

  if(!packer.pack || !packer.unpack)
    throw new SyntaxError('Packer is invalid');

  var responseMethods = unifyResponseMethods(packer.responseMethods);


  if(options instanceof Function || options && options.send instanceof Function)
  {
    if(transport && !(transport instanceof Function))
      throw new SyntaxError("Only a function can be after transport");

    onRequest = transport;
    transport = options;
    options   = undefined;
  };

  if(transport instanceof Function
  || transport && transport.send instanceof Function)
    if(onRequest && !(onRequest instanceof Function))
      throw new SyntaxError("Only a function can be after transport");

  options = options || {};


  EventEmitter.call(this);

  if(onRequest)
    this.on('request', onRequest);


  Object.defineProperty(this, 'peerID', {value: options.peerID});

  var max_retries = options.max_retries || 0;


  function transportMessage(event)
  {
    var message = self.decode(event.data);
    if(message)
      self.emit('request', message);
  };

  Object.defineProperty(this, 'transport',
  {
    get: function()
    {
      return transport;
    },

    set: function(value)
    {
      // Remove listener from old transport
      if(transport && transport.onmessage !== undefined)
        transport.removeEventListener('message', transportMessage);

      // Set listener on new transport
      if(value && value.onmessage !== undefined)
        value.addEventListener('message', transportMessage);

      transport = unifyTransport(value);
    }
  })

  this.transport = transport;


  const request_timeout    = options.request_timeout    || BASE_TIMEOUT;
  const response_timeout   = options.response_timeout   || BASE_TIMEOUT;
  const duplicates_timeout = options.duplicates_timeout || BASE_TIMEOUT;


  var requestID = 0;

  var requests  = new Mapper();
  var responses = new Mapper();
  var processedResponses = new Mapper();

  var message2Key = {};


  /**
   * Store the response to prevent to process duplicate request later
   */
  function storeResponse(message, id, dest)
  {
    var response =
    {
      message: message,
      /** Timeout to auto-clean old responses */
      timeout: setTimeout(function()
      {
        responses.remove(id, dest);
      },
      response_timeout)
    };

    responses.set(response, id, dest);
  };

  /**
   * Store the response to ignore duplicated messages later
   */
  function storeProcessedResponse(ack, from)
  {
    var timeout = setTimeout(function()
    {
      processedResponses.remove(ack, from);
    },
    duplicates_timeout);

    processedResponses.set(timeout, ack, from);
  };


  /**
   * Representation of a RPC request
   *
   * @class
   * @extends RpcNotification
   *
   * @constructor
   *
   * @param {String} method -method of the notification
   * @param params - parameters of the notification
   * @param {Integer} id - identifier of the request
   * @param [from] - source of the notification
   */
  function RpcRequest(method, params, id, from, transport)
  {
    RpcNotification.call(this, method, params);

    Object.defineProperty(this, 'transport',
    {
      get: function()
      {
        return transport;
      },

      set: function(value)
      {
        transport = unifyTransport(value);
      }
    })

    var response = responses.get(id, from);

    /**
     * @constant {Boolean} duplicated
     */
    if(!(transport || self.transport))
      Object.defineProperty(this, 'duplicated',
      {
        value: Boolean(response)
      });

    var responseMethod = responseMethods[method];

    this.pack = function()
    {
      return packer.pack(this, id);
    }

    /**
     * Generate a response to this request
     *
     * @param {Error} [error]
     * @param {*} [result]
     *
     * @returns {string}
     */
    this.reply = function(error, result, transport)
    {
      // Fix optional parameters
      if(error instanceof Function || error && error.send instanceof Function)
      {
        if(result != undefined)
          throw new SyntaxError("There can't be parameters after callback");

        transport = error;
        result = null;
        error = undefined;
      }

      else if(result instanceof Function
      || result && result.send instanceof Function)
      {
        if(transport != undefined)
          throw new SyntaxError("There can't be parameters after callback");

        transport = result;
        result = null;
      };

      transport = unifyTransport(transport);

      // Duplicated request, remove old response timeout
      if(response)
        clearTimeout(response.timeout);

      if(from != undefined)
      {
        if(error)
          error.dest = from;

        if(result)
          result.dest = from;
      };

      var message;

      // New request or overriden one, create new response with provided data
      if(error || result != undefined)
      {
        if(self.peerID != undefined)
        {
          if(error)
            error.from = self.peerID;
          else
            result.from = self.peerID;
        }

        // Protocol indicates that responses has own request methods
        if(responseMethod)
        {
          if(responseMethod.error == undefined && error)
            message =
            {
              error: error
            };

          else
          {
            var method = error
                       ? responseMethod.error
                       : responseMethod.response;

            message =
            {
              method: method,
              params: error || result
            };
          }
        }
        else
          message =
          {
            error:  error,
            result: result
          };

        message = packer.pack(message, id);
      }

      // Duplicate & not-overriden request, re-send old response
      else if(response)
        message = response.message;

      // New empty reply, response null value
      else
        message = packer.pack({result: null}, id);

      // Store the response to prevent to process a duplicated request later
      storeResponse(message, id, from);

      // Return the stored response so it can be directly send back
      transport = transport || this.transport || self.transport;

      if(transport)
        return transport(message);

      return message;
    }
  };
  inherits(RpcRequest, RpcNotification);


  function cancel(message)
  {
    var key = message2Key[message];
    if(!key) return;

    delete message2Key[message];

    var request = requests.pop(key.id, key.dest);
    if(!request) return;

    clearTimeout(request.timeout);

    // Start duplicated responses timeout
    storeProcessedResponse(key.id, key.dest);
  };

  /**
   * Allow to cancel a request and don't wait for a response
   *
   * If `message` is not given, cancel all the request
   */
  this.cancel = function(message)
  {
    if(message) return cancel(message);

    for(var message in message2Key)
      cancel(message);
  };


  this.close = function()
  {
    // Prevent to receive new messages
    var transport = self.transport;
    if(transport && transport.close)
       transport.close();

    // Request & processed responses
    this.cancel();

    processedResponses.forEach(function(timeout)
    {
      clearTimeout(timeout);
    });

    // Responses
    responses.forEach(function(response)
    {
      clearTimeout(response.timeout);
    });
  };


  /**
   * Generates and encode a JsonRPC 2.0 message
   *
   * @param {String} method -method of the notification
   * @param params - parameters of the notification
   * @param [dest] - destination of the notification
   * @param {object} [transport] - transport where to send the message
   * @param [callback] - function called when a response to this request is
   *   received. If not defined, a notification will be send instead
   *
   * @returns {string} A raw JsonRPC 2.0 request or notification string
   */
  this.encode = function(method, params, dest, transport, callback)
  {
    // Fix optional parameters
    if(params instanceof Function)
    {
      if(dest != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = params;
      transport = undefined;
      dest      = undefined;
      params    = undefined;
    }

    else if(dest instanceof Function)
    {
      if(transport != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = dest;
      transport = undefined;
      dest      = undefined;
    }

    else if(transport instanceof Function)
    {
      if(callback != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = transport;
      transport = undefined;
    };

    if(self.peerID != undefined)
    {
      params = params || {};

      params.from = self.peerID;
    };

    if(dest != undefined)
    {
      params = params || {};

      params.dest = dest;
    };

    // Encode message
    var message =
    {
      method: method,
      params: params
    };

    if(callback)
    {
      var id = requestID++;
      var retried = 0;

      message = packer.pack(message, id);

      var request =
      {
        message:         message,
        callback:        dispatchCallback,
        responseMethods: responseMethods[method] || {}
      };

      function dispatchCallback(error, result)
      {
        self.cancel(message);

        callback(error, result);
      };

      var encode_transport = unifyTransport(transport);

      function sendRequest(transport)
      {
        request.timeout = setTimeout(timeout,
                                     request_timeout*Math.pow(2, retried++));
        message2Key[message] = {id: id, dest: dest};
        requests.set(request, id, dest);

        transport = transport || encode_transport || self.transport;
        if(transport)
          return transport(message);

        return message;
      };

      function retry(transport)
      {
        transport = unifyTransport(transport);

        console.warn(retried+' retry for request message:',message);

        var timeout = processedResponses.pop(id, dest);
        clearTimeout(timeout);

        return sendRequest(transport);
      };

      function timeout()
      {
        if(retried < max_retries)
          return retry(transport);

        var error = new Error('Request has timed out');
            error.request = message;

        error.retry = retry;

        dispatchCallback(error)
      };

      return sendRequest(transport);
    };

    // Return the packed message
    message = packer.pack(message);

    transport = transport || self.transport;
    if(transport)
      return transport(message);

    return message;
  };

  /**
   * Decode and process a JsonRPC 2.0 message
   *
   * @param {string} message - string with the content of the message
   *
   * @returns {RpcNotification|RpcRequest|undefined} - the representation of the
   *   notification or the request. If a response was processed, it will return
   *   `undefined` to notify that it was processed
   *
   * @throws {TypeError} - Message is not defined
   */
  this.decode = function(message, transport)
  {
    if(!message)
      throw new TypeError("Message is not defined");

    try
    {
      message = packer.unpack(message);
    }
    catch(e)
    {
      // Ignore invalid messages
      return console.debug(e, message);
    };

    var id     = message.id;
    var ack    = message.ack;
    var method = message.method;
    var params = message.params || {};

    var from = params.from;
    var dest = params.dest;

    // Ignore messages send by us
    if(self.peerID != undefined && from == self.peerID) return;

    // Notification
    if(id == undefined && ack == undefined)
      return new RpcNotification(method, params);


    function processRequest()
    {
      // If we have a transport and it's a duplicated request, reply inmediatly
      transport = unifyTransport(transport) || self.transport;
      if(transport)
      {
        var response = responses.get(id, from);
        if(response)
          return transport(response.message);
      };

      var idAck = (id != undefined) ? id : ack;
      return new RpcRequest(method, params, idAck, from, transport);
    };

    function processResponse(request, error, result)
    {
      request.callback(error, result);
    };

    function duplicatedResponse(timeout)
    {
      console.warn("Response already processed", message);

      // Update duplicated responses timeout
      clearTimeout(timeout);
      storeProcessedResponse(ack, from);
    };


    // Request, or response with own method
    if(method)
    {
      // Check if it's a response with own method
      if(dest == undefined || dest == self.peerID)
      {
        var request = requests.get(ack, from);
        if(request)
        {
          var responseMethods = request.responseMethods;

          if(method == responseMethods.error)
            return processResponse(request, params);

          if(method == responseMethods.response)
            return processResponse(request, null, params);

          return processRequest();
        }

        var processed = processedResponses.get(ack, from);
        if(processed)
          return duplicatedResponse(processed);
      }

      // Request
      return processRequest();
    };

    var error  = message.error;
    var result = message.result;

    // Ignore responses not send to us
    if(error  && error.dest  && error.dest  != self.sessionID) return;
    if(result && result.dest && result.dest != self.sessionID) return;

    // Response
    var request = requests.get(ack, from);
    if(!request)
    {
      var processed = processedResponses.get(ack, from);
      if(processed)
        return duplicatedResponse(processed);

      return console.warn("No callback was defined for this message", message);
    };

    // Process response
    processResponse(request, error, result);
  };
};
inherits(RpcBuilder, EventEmitter);


RpcBuilder.RpcNotification = RpcNotification;


module.exports = RpcBuilder;

RpcBuilder.packers = packers;

},{"./Mapper":8,"./packers":12,"events":6,"inherits":7}],10:[function(require,module,exports){
/**
 * JsonRPC 2.0 packer
 */

/**
 * Pack a JsonRPC 2.0 message
 *
 * @param {Object} message - object to be packaged. It requires to have all the
 *   fields needed by the JsonRPC 2.0 message that it's going to be generated
 *
 * @return {String} - the stringified JsonRPC 2.0 message
 */
function pack(message, id)
{
  var result =
  {
    jsonrpc: "2.0"
  };

  // Request
  if(message.method)
  {
    result.method = message.method;

    if(message.params)
      result.params = message.params;

    // Request is a notification
    if(id != undefined)
      result.id = id;
  }

  // Response
  else if(id != undefined)
  {
    if(message.error)
    {
      if(message.result !== undefined)
        throw new TypeError("Both result and error are defined");

      result.error = message.error;
    }
    else if(message.result !== undefined)
      result.result = message.result;
    else
      throw new TypeError("No result or error is defined");

    result.id = id;
  };

  return JSON.stringify(result);
};

/**
 * Unpack a JsonRPC 2.0 message
 *
 * @param {String} message - string with the content of the JsonRPC 2.0 message
 *
 * @throws {TypeError} - Invalid JsonRPC version
 *
 * @return {Object} - object filled with the JsonRPC 2.0 message content
 */
function unpack(message)
{
  var result = message;

  if(typeof message == 'string' || message instanceof String)
    result = JSON.parse(message);

  // Check if it's a valid message

  var version = result.jsonrpc;
  if(version != "2.0")
    throw new TypeError("Invalid JsonRPC version '"+version+"': "+message);

  // Response
  if(result.method == undefined)
  {
    if(result.id == undefined)
      throw new TypeError("Invalid message: "+message);

    var result_defined = result.result !== undefined;
    var error_defined  = result.error  !== undefined;

    // Check only result or error is defined, not both or none
    if(result_defined && error_defined)
      throw new TypeError("Both result and error are defined: "+message);

    if(!result_defined && !error_defined)
      throw new TypeError("No result or error is defined: "+message);

    result.ack = result.id;
    delete result.id;
  }

  // Return unpacked message
  return result;
};


exports.pack   = pack;
exports.unpack = unpack;

},{}],11:[function(require,module,exports){
function pack(message)
{
  throw new TypeError("Not yet implemented");
};

function unpack(message)
{
  throw new TypeError("Not yet implemented");
};


exports.pack   = pack;
exports.unpack = unpack;

},{}],12:[function(require,module,exports){
var JsonRPC = require('./JsonRPC');
var XmlRPC  = require('./XmlRPC');


exports.JsonRPC = JsonRPC;
exports.XmlRPC  = XmlRPC;

},{"./JsonRPC":10,"./XmlRPC":11}],13:[function(require,module,exports){
module.exports = XMLHttpRequest;
},{}]},{},[5])