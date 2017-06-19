var appd = require('appdynamics');
var appdConfig = require('./appdConfig.json');
appd.profile(appdConfig);

var amqp = require('amqplib/callback_api');

// if the connection is closed or fails to be established at all, we will reconnect
var amqpConn = null;
function start() {
  amqp.connect(process.env.CLOUDAMQP_URL + "?heartbeat=60", function(err, conn) {
    if (err) {
      console.error("[AMQP]", err.message);
      return setTimeout(start, 1000);
    }
    conn.on("error", function(err) {
      if (err.message !== "Connection closing") {
        console.error("[AMQP] conn error", err.message);
      }
    });
    conn.on("close", function() {
      console.error("[AMQP] reconnecting");
      return setTimeout(start, 1000);
    });

    console.log("[AMQP] connected");
    amqpConn = conn;

    whenConnected();
  });
}

function whenConnected() {
  startPublisher();
}

var pubChannel = null;
var offlinePubQueue = [];
function startPublisher() {
  amqpConn.createConfirmChannel(function(err, ch) {
    if (closeOnErr(err)) return;
    ch.on("error", function(err) {
      console.error("[AMQP] channel error", err.message);
    });
    ch.on("close", function() {
      console.log("[AMQP] channel closed");
    });

    pubChannel = ch;
    while (true) {
      var m = offlinePubQueue.shift();
      if (!m) break;
      console.log('queued message', m);
      publish(m[0], m[1], m[2], m[3]);
    }
  });
}

// method to publish a message, will queue messages internally if the connection is down and resend later
function publish(exchange, routingKey, content, headers) {
  console.log('publish', exchange, routingKey, content, headers);
  var trx = appd.startTransaction('doWork');
  try {
    var xit = trx.startExitCall({
      exitType: 'EXIT_HTTP',
      label: 'mq message',
      name: 'mq message',
      backendName: 'rabbit-mq',
      identifyingProperties: {
        'HOST': 'mq',
        'PORT': '5672',
        'URL': process.env.CLOUDAMQP_URL
      }
    });

    var cor = trx.createCorrelationInfo(xit);
    console.log('cor', cor);

    var options = { persistent: true };
    options.headers = {};
    options.headers.appd = cor;
    console.log('options', options);

    pubChannel.publish(exchange, routingKey, content, options, function(err, ok) {
      if (err) {
        console.error("[AMQP] publish", err.stack);
        trx.markError(e);
        pubChannel.connection.close();
      }

      trx.endExitCall(xit);
      if (trx) trx.end();
    });
  } catch (e) {
    console.error("[AMQP] publish", e.stack);
    if (trx) trx.end(e);
  }
}

function closeOnErr(err) {
  if (!err) return false;
  console.error("[AMQP] error", err);
  amqpConn.close();
  return true;
}

setInterval(function() {
  publish("", "jobs", new Buffer("work work work"));
}, 1000);

start();
