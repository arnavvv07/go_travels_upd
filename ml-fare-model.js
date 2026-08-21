// ---------------------------------------------------------------------------
// ML fare adjustment model (TensorFlow.js, pure-JS backend — no native
// compilation, so it installs reliably on Render's free tier).
//
// Predicts a fare multiplier (roughly 0.75x - 1.85x) from trip features:
// [distance, hour of day, day of week, traffic level, demand level, rain].
// The base per-km fare (computed the normal way) is then multiplied by this
// prediction — the same idea real ride-hailing surge pricing uses, except
// here it's driven by a small trained neural network instead of a lookup
// table.
//
// Trained once at server startup on synthetic data from simulation.js.
// ---------------------------------------------------------------------------

const tf = require("@tensorflow/tfjs");
const sim = require("./simulation");

let model = null;
let trainingInfo = { ready: false, finalLoss: null, samples: 0, trainedAt: null };

function buildModel() {
    const m = tf.sequential();
    m.add(tf.layers.dense({ inputShape: [6], units: 16, activation: "relu" }));
    m.add(tf.layers.dense({ units: 8, activation: "relu" }));
    m.add(tf.layers.dense({ units: 1, activation: "sigmoid" })); // 0..1, rescaled below
    m.compile({ optimizer: tf.train.adam(0.01), loss: "meanSquaredError" });
    return m;
}

// sigmoid output (0..1) rescaled to the real multiplier range (0.7..1.9)
const OUT_MIN = 0.7, OUT_MAX = 1.9;
function toMultiplier(sigmoidOutput) { return OUT_MIN + sigmoidOutput * (OUT_MAX - OUT_MIN); }
function toSigmoidTarget(multiplier) { return (multiplier - OUT_MIN) / (OUT_MAX - OUT_MIN); }

async function trainModel(sampleCount) {
    sampleCount = sampleCount || 4000;
    const xs = [];
    const ys = [];

    for (let i = 0; i < sampleCount; i++) {
        const s = sim.generateTrainingSample();
        xs.push(s.features);
        ys.push([toSigmoidTarget(s.label)]);
    }

    const xsT = tf.tensor2d(xs);
    const ysT = tf.tensor2d(ys);

    const m = buildModel();
    const history = await m.fit(xsT, ysT, {
        epochs: 25,
        batchSize: 64,
        shuffle: true,
        verbose: 0
    });

    xsT.dispose();
    ysT.dispose();

    model = m;
    trainingInfo = {
        ready: true,
        finalLoss: history.history.loss[history.history.loss.length - 1],
        samples: sampleCount,
        trainedAt: new Date().toISOString()
    };

    console.log(
        `[ml-fare-model] trained on ${sampleCount} simulated trips — final loss ${trainingInfo.finalLoss.toFixed(5)}`
    );

    return trainingInfo;
}

function predictMultiplier(features) {
    if (!model) return null;
    return tf.tidy(() => {
        const input = tf.tensor2d([features]);
        const output = model.predict(input);
        const sigmoidVal = output.dataSync()[0];
        return Math.round(toMultiplier(sigmoidVal) * 100) / 100;
    });
}

function getTrainingInfo() {
    return trainingInfo;
}

module.exports = { trainModel, predictMultiplier, getTrainingInfo };
