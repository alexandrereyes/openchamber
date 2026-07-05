export function registerSmallModelRoutes(app, { getSmallModelService }) {
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel } = await getSmallModelService();
      const resolved = await describeSmallModel({
        directory: typeof req.query.directory === 'string' ? req.query.directory : undefined,
      });
      res.json({ available: Boolean(resolved), model: resolved });
    } catch (error) {
      console.error('Failed to resolve small model:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory } = req.body || {};
      const result = await generateSmallModelText({ prompt, system, maxOutputTokens, model, directory });
      res.json(result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      res.status(statusCode).json({ error: error.message || 'Small model generation failed' });
    }
  });
}
