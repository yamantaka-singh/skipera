import json
import os
from pydantic import BaseModel
from typing import Any, List, Literal, Optional
from loguru import logger
from litellm import completion

from .. import config


class ResponseFormat(BaseModel):
    question_id: str
    reasoning: str
    chosen: Optional[List[str]] = None
    answer: Optional[str] = None


class ResponseList(BaseModel):
    responses: List[ResponseFormat]


DEFAULT_RESPONSE_SCHEMA = ResponseList.model_json_schema()

# provider -> (litellm model prefix, api key, model override, env var litellm reads the key from)
PROVIDERS = {
    "perplexity": ("perplexity", config.PERPLEXITY_API_KEY, config.PERPLEXITY_MODEL, "PERPLEXITYAI_API_KEY"),
    "openai": ("openai", config.OPENAI_API_KEY, config.OPENAI_MODEL, "OPENAI_API_KEY"),
    "anthropic": ("anthropic", config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL, "ANTHROPIC_API_KEY"),
    "nvidia": ("nvidia_nim", config.NVIDIA_API_KEY, config.NVIDIA_MODEL, "NVIDIA_NIM_API_KEY"),
    "gemini": ("gemini", config.GEMINI_API_KEY, config.GEMINI_MODEL, "GEMINI_API_KEY"),
}


def get_connector() -> "LiteLLMConnector":
    for name, (_, api_key, _, _) in PROVIDERS.items():
        if api_key:
            return LiteLLMConnector(name)
    raise RuntimeError("No API Key specified.")


class LiteLLMConnector(object):
    def __init__(self, provider: str):
        prefix, api_keys, model, env_var = PROVIDERS[provider]
        self.model = f"{prefix}/{model}"
        self.env_var = env_var
        self.api_keys = api_keys if isinstance(api_keys, list) else [api_keys]
        self.current_key_idx = 0
        if self.api_keys:
            os.environ[self.env_var] = self.api_keys[self.current_key_idx]

    def get_response(
            self,
            prompt: dict | str,
            system_prompt: str,
            response_schema: dict[str, Any] | None = None
    ) -> dict | str:
        """
        Sends a prompt via LiteLLM and optionally asks for a JSON schema response.
        """
        logger.debug(f"Making an API request to {self.model}...")
        kwargs = {}
        if response_schema is not None:
            kwargs["response_format"] = {"type": "json_object"}

        if "nvidia" in self.model or "nemotron" in self.model:
            kwargs["extra_body"] = {
                "chat_template_kwargs": {"enable_thinking": False}
            }

        kwargs["temperature"] = 0.0
        kwargs["top_p"] = 1.0
        kwargs["presence_penalty"] = 0.0
        kwargs["frequency_penalty"] = 0.0

        from litellm.exceptions import RateLimitError, AuthenticationError
        if response_schema is not None:
            system_prompt += "\n\nCRITICAL: You must respond with a valid JSON object matching this schema:\n" + json.dumps(response_schema)
            
        user_msg = json.dumps(prompt, indent=2) if isinstance(prompt, dict) else prompt
        logger.debug(f"=== [LLM PROMPT] ===\nSystem: {system_prompt}\nUser: {user_msg}\n====================")
        
        for attempt in range(len(self.api_keys) or 1):
            try:
                response = completion(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_msg},
                    ],
                    timeout=300.0,
                    **kwargs,
                )
                break
            except (RateLimitError, AuthenticationError) as e:
                logger.warning(f"Key {self.current_key_idx} failed with {type(e).__name__}: {str(e)}")
                if len(self.api_keys) > 1:
                    self.current_key_idx = (self.current_key_idx + 1) % len(self.api_keys)
                    os.environ[self.env_var] = self.api_keys[self.current_key_idx]
                    logger.info(f"Swapped to next key (index {self.current_key_idx}). Retrying...")
                if attempt == len(self.api_keys) - 1:
                    raise e

        content = response["choices"][0]["message"]["content"]
        logger.debug(f"=== [LLM RAW RESPONSE] ===\n{content}\n==========================")
        if response_schema is not None:
            if isinstance(content, str):
                start = content.find("{")
                end = content.rfind("}")
                if start != -1 and end != -1:
                    content = content[start:end+1]
            return json.loads(content)
        return content.strip()
